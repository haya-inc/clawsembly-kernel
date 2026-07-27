use std::{
    collections::HashSet,
    env,
    net::{IpAddr, SocketAddr},
    str::FromStr,
    sync::Arc,
};

use anyhow::{bail, Context};
use futures_util::{SinkExt, StreamExt};
use subtle::ConstantTimeEq;
use tokio::{net::TcpListener, sync::mpsc};
use tokio_tungstenite::{
    accept_hdr_async,
    tungstenite::{
        handshake::server::{ErrorResponse, Request, Response},
        http::{header::SEC_WEBSOCKET_PROTOCOL, HeaderValue, StatusCode},
        Message,
    },
};
use virtual_net::{
    host::LocalNetworking,
    meta::{MessageRequest, MessageResponse},
    ruleset::Ruleset,
    NetworkError, RemoteNetworkingServer, VirtualNetworking, VirtualTcpSocket,
};

const CAPABILITY_PROTOCOL_PREFIX: &str = "clawsembly.capability.";
const NETWORK_PATH: &str = "/v1/network";

#[derive(Clone, Debug, PartialEq, Eq)]
struct Config {
    listen: SocketAddr,
    allow: Vec<(String, u16)>,
    allow_private_network: bool,
    token: String,
}

impl Config {
    fn parse() -> anyhow::Result<Self> {
        let mut listen = "127.0.0.1:18792".parse().unwrap();
        let mut allow = Vec::new();
        let mut allow_private_network = false;
        let mut args = env::args().skip(1);

        while let Some(argument) = args.next() {
            match argument.as_str() {
                "--listen" => {
                    listen = args
                        .next()
                        .context("--listen requires an IP:port value")?
                        .parse()
                        .context("--listen must be an IP:port value")?;
                }
                "--allow" => {
                    let value = args.next().context("--allow requires a host:port value")?;
                    allow.push(parse_host_port(&value)?);
                }
                "--allow-private-network" => allow_private_network = true,
                "--help" | "-h" => {
                    println!(
                        "Usage: clawsembly-network-relay [--listen IP:PORT] \\
                         --allow HOST:PORT [--allow HOST:PORT ...] \\
                         [--allow-private-network]\n\n\
                         Set CLAWSEMBLY_NETWORK_RELAY_TOKEN to a 1-128 character \\
                         URL-safe capability token."
                    );
                    std::process::exit(0);
                }
                unknown => bail!("unknown argument: {unknown}"),
            }
        }

        if allow.is_empty() {
            bail!("at least one --allow HOST:PORT is required");
        }
        let mut unique = HashSet::new();
        if let Some(duplicate) = allow.iter().find(|entry| !unique.insert((*entry).clone())) {
            bail!("duplicate --allow entry: {}:{}", duplicate.0, duplicate.1);
        }

        let token = env::var("CLAWSEMBLY_NETWORK_RELAY_TOKEN")
            .context("CLAWSEMBLY_NETWORK_RELAY_TOKEN is required")?;
        validate_token(&token)?;

        Ok(Self {
            listen,
            allow,
            allow_private_network,
            token,
        })
    }

    fn ruleset(&self) -> anyhow::Result<Ruleset> {
        let mut rules = self
            .allow
            .iter()
            .map(|(host, port)| format!("dns:allow={host}:{port}"))
            .collect::<Vec<_>>();
        if !self.allow_private_network {
            rules.extend([
                "ipv4:deny={0.0.0.0/8,10.0.0.0/8,100.64.0.0/10,127.0.0.0/8,169.254.0.0/16,172.16.0.0/12,192.0.0.0/24,192.0.2.0/24,192.88.99.0/24,192.168.0.0/16,198.18.0.0/15,198.51.100.0/24,203.0.113.0/24,224.0.0.0/4,240.0.0.0/4}:*/out".to_string(),
                "ipv6:deny={::/128,::1/128,::ffff:0:0/96,2001:db8::/32,fc00::/7,fe80::/10,fec0::/10,ff00::/8}:*/out".to_string(),
            ]);
        }
        Ruleset::from_str(&rules.join(",")).context("failed to build relay firewall rules")
    }
}

#[derive(Debug)]
struct TcpEgressNetworking {
    inner: LocalNetworking,
}

#[async_trait::async_trait]
impl VirtualNetworking for TcpEgressNetworking {
    async fn connect_tcp(
        &self,
        local_address: SocketAddr,
        peer_address: SocketAddr,
    ) -> virtual_net::Result<Box<dyn VirtualTcpSocket + Sync>> {
        self.inner.connect_tcp(local_address, peer_address).await
    }

    async fn resolve(
        &self,
        host: &str,
        port: Option<u16>,
        dns_server: Option<IpAddr>,
    ) -> virtual_net::Result<Vec<IpAddr>> {
        if dns_server.is_some() {
            return Err(NetworkError::PermissionDenied);
        }
        self.inner.resolve(host, port, None).await
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let config = Config::parse()?;
    let ruleset = config.ruleset()?;
    let networking = Arc::new(TcpEgressNetworking {
        inner: LocalNetworking::with_ruleset(ruleset),
    });
    let listener = TcpListener::bind(config.listen)
        .await
        .with_context(|| format!("failed to listen on {}", config.listen))?;
    let local_address = listener.local_addr()?;

    println!(
        "{{\"status\":\"ready\",\"listen\":\"{local_address}\",\
         \"path\":\"{NETWORK_PATH}\",\"allowCount\":{},\
         \"allowPrivateNetwork\":{}}}",
        config.allow.len(),
        config.allow_private_network
    );

    loop {
        let (stream, peer_address) = listener.accept().await?;
        let token = config.token.clone();
        let networking = networking.clone();
        tokio::spawn(async move {
            if let Err(error) = serve_connection(stream, token, networking).await {
                eprintln!("relay connection {peer_address} closed: {error:#}");
            }
        });
    }
}

async fn serve_connection(
    stream: tokio::net::TcpStream,
    token: String,
    networking: Arc<TcpEgressNetworking>,
) -> anyhow::Result<()> {
    let expected_protocol = format!("{CAPABILITY_PROTOCOL_PREFIX}{token}");
    let response_protocol = HeaderValue::from_str(&expected_protocol)?;
    let websocket = accept_hdr_async(stream, move |request: &Request, mut response: Response| {
        if request.uri().path() != NETWORK_PATH {
            return Err(handshake_error(StatusCode::NOT_FOUND, "not found"));
        }
        let authorized = request
            .headers()
            .get(SEC_WEBSOCKET_PROTOCOL)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|protocols| {
                protocols.split(',').map(str::trim).any(|candidate| {
                    candidate.len() == expected_protocol.len()
                        && bool::from(candidate.as_bytes().ct_eq(expected_protocol.as_bytes()))
                })
            });
        if !authorized {
            return Err(handshake_error(StatusCode::UNAUTHORIZED, "unauthorized"));
        }
        response
            .headers_mut()
            .insert(SEC_WEBSOCKET_PROTOCOL, response_protocol.clone());
        Ok(response)
    })
    .await
    .context("WebSocket handshake failed")?;
    eprintln!("authorized virtual-net WebSocket");

    let (mut websocket_tx, mut websocket_rx) = websocket.split();
    let (request_tx, request_rx) = mpsc::channel::<MessageRequest>(100);
    let (response_tx, mut response_rx) = mpsc::channel::<MessageResponse>(100);
    let (_server, driver) =
        RemoteNetworkingServer::new_from_mpsc(response_tx, request_rx, networking);
    let mut driver = tokio::spawn(driver);

    loop {
        tokio::select! {
            message = websocket_rx.next() => {
                match message.transpose()? {
                    Some(Message::Binary(bytes)) => {
                        let request = bincode::deserialize(&bytes)
                            .context("invalid virtual-net request frame")?;
                        request_tx
                            .send(request)
                            .await
                            .map_err(|_| NetworkError::ConnectionAborted)?;
                    }
                    Some(Message::Close(_)) | None => break,
                    Some(Message::Ping(bytes)) => {
                        websocket_tx.send(Message::Pong(bytes)).await?;
                    }
                    Some(Message::Pong(_)) => {}
                    Some(Message::Text(_)) | Some(Message::Frame(_)) => {
                        bail!("only binary virtual-net frames are accepted");
                    }
                }
            }
            response = response_rx.recv() => {
                let Some(response) = response else {
                    break;
                };
                websocket_tx
                    .send(Message::Binary(bincode::serialize(&response)?))
                    .await?;
            }
            result = &mut driver => {
                result.context("virtual-net driver task failed")?;
                break;
            }
        }
    }
    driver.abort();
    Ok(())
}

fn handshake_error(status: StatusCode, body: &'static str) -> ErrorResponse {
    let mut response = ErrorResponse::new(Some(body.to_string()));
    *response.status_mut() = status;
    response
}

fn parse_host_port(value: &str) -> anyhow::Result<(String, u16)> {
    let (host, port) = value
        .rsplit_once(':')
        .context("--allow must use HOST:PORT")?;
    let host = match url::Host::parse(host)? {
        url::Host::Domain(host) if !host.is_empty() && !host.contains('*') => {
            host.to_ascii_lowercase()
        }
        _ => bail!("--allow hosts must be exact DNS names"),
    };
    let port = port.parse::<u16>().context("--allow port is invalid")?;
    if port == 0 {
        bail!("--allow port must be between 1 and 65535");
    }
    Ok((host, port))
}

fn validate_token(token: &str) -> anyhow::Result<()> {
    if token.is_empty()
        || token.len() > 128
        || !token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        bail!("capability token must be 1-128 URL-safe protocol characters");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use virtual_net::ruleset::Direction;

    #[test]
    fn exact_dns_rule_expands_only_to_the_granted_port() {
        let config = Config {
            listen: "127.0.0.1:18792".parse().unwrap(),
            allow: vec![("api.example.com".to_string(), 443)],
            allow_private_network: false,
            token: "test-token".to_string(),
        };
        let ruleset = config.ruleset().unwrap();
        assert!(ruleset.allows_domain("api.example.com"));
        assert!(!ruleset.allows_domain("sub.api.example.com"));
        assert!(!ruleset.allows_domain("other.example.com"));
        ruleset
            .expand_domain("api.example.com", &["203.0.114.10".parse().unwrap()])
            .unwrap();
        assert!(ruleset.allows_socket(
            "203.0.114.10:443".parse::<SocketAddr>().unwrap(),
            Direction::Outbound
        ));
        assert!(!ruleset.allows_socket(
            "203.0.114.10:80".parse::<SocketAddr>().unwrap(),
            Direction::Outbound
        ));
    }

    #[test]
    fn private_and_special_use_ranges_are_denied_by_default() {
        let config = Config {
            listen: "127.0.0.1:18792".parse().unwrap(),
            allow: vec![("api.example.com".to_string(), 443)],
            allow_private_network: false,
            token: "test-token".to_string(),
        };
        let ruleset = config.ruleset().unwrap();
        ruleset
            .expand_domain(
                "api.example.com",
                &[
                    "127.0.0.1".parse().unwrap(),
                    "10.0.0.1".parse().unwrap(),
                    "2001:db8::1".parse().unwrap(),
                ],
            )
            .unwrap();
        for address in ["127.0.0.1:443", "10.0.0.1:443", "[2001:db8::1]:443"] {
            assert!(
                !ruleset.allows_socket(address.parse::<SocketAddr>().unwrap(), Direction::Outbound)
            );
        }
    }

    #[test]
    fn allow_parser_rejects_wildcards_and_numeric_ips() {
        assert!(parse_host_port("*.example.com:443").is_err());
        assert!(parse_host_port("127.0.0.1:443").is_err());
        assert_eq!(
            parse_host_port("API.EXAMPLE.COM:443").unwrap(),
            ("api.example.com".to_string(), 443)
        );
    }

    #[tokio::test]
    async fn explicit_dns_servers_are_denied() {
        let networking = TcpEgressNetworking {
            inner: LocalNetworking::with_ruleset(
                Ruleset::from_str("dns:allow=api.example.com:443").unwrap(),
            ),
        };
        let error = networking
            .resolve(
                "api.example.com",
                Some(443),
                Some("8.8.8.8".parse().unwrap()),
            )
            .await
            .unwrap_err();
        assert!(matches!(error, NetworkError::PermissionDenied));
    }
}
