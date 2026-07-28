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
use tokio::{
    net::TcpListener,
    sync::{mpsc, Semaphore},
};
use tokio_tungstenite::{
    accept_hdr_async_with_config,
    tungstenite::{
        handshake::server::{ErrorResponse, Request, Response},
        http::{header::SEC_WEBSOCKET_PROTOCOL, HeaderValue, StatusCode},
        protocol::WebSocketConfig,
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
const DEFAULT_MAX_CONNECTIONS: usize = 4;
const DEFAULT_MAX_FRAME_BYTES: usize = 2 * 1024 * 1024;
const MAX_CONFIGURED_CONNECTIONS: usize = 1_024;
const MAX_CONFIGURED_FRAME_BYTES: usize = 16 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
struct Config {
    listen: SocketAddr,
    allow: Vec<(String, u16)>,
    allow_private_network: bool,
    max_connections: usize,
    max_frame_bytes: usize,
    token: String,
}

impl Config {
    fn parse() -> anyhow::Result<Self> {
        let mut listen = "127.0.0.1:18792".parse().unwrap();
        let mut allow = Vec::new();
        let mut allow_private_network = false;
        let mut max_connections = DEFAULT_MAX_CONNECTIONS;
        let mut max_frame_bytes = DEFAULT_MAX_FRAME_BYTES;
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
                "--max-connections" => {
                    max_connections = parse_bounded_usize(
                        &args.next().context("--max-connections requires a value")?,
                        "--max-connections",
                        MAX_CONFIGURED_CONNECTIONS,
                    )?;
                }
                "--max-frame-bytes" => {
                    max_frame_bytes = parse_bounded_usize(
                        &args.next().context("--max-frame-bytes requires a value")?,
                        "--max-frame-bytes",
                        MAX_CONFIGURED_FRAME_BYTES,
                    )?;
                }
                "--help" | "-h" => {
                    println!(
                        "Usage: clawsembly-network-relay [--listen IP:PORT] \\
                         --allow HOST:PORT [--allow HOST:PORT ...] \\
                         [--allow-private-network] \\
                         [--max-connections COUNT] [--max-frame-bytes BYTES]\n\n\
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
            max_connections,
            max_frame_bytes,
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
    let connection_slots = Arc::new(Semaphore::new(config.max_connections));

    println!(
        "{{\"status\":\"ready\",\"listen\":\"{local_address}\",\
         \"path\":\"{NETWORK_PATH}\",\"allowCount\":{},\
         \"allowPrivateNetwork\":{},\"maxConnections\":{},\
         \"maxFrameBytes\":{}}}",
        config.allow.len(),
        config.allow_private_network,
        config.max_connections,
        config.max_frame_bytes
    );

    loop {
        let (stream, peer_address) = listener.accept().await?;
        let Ok(connection_slot) = connection_slots.clone().try_acquire_owned() else {
            eprintln!("relay connection {peer_address} rejected: connection limit reached");
            drop(stream);
            continue;
        };
        let token = config.token.clone();
        let networking = networking.clone();
        let max_frame_bytes = config.max_frame_bytes;
        tokio::spawn(async move {
            let _connection_slot = connection_slot;
            if let Err(error) = serve_connection(stream, token, networking, max_frame_bytes).await {
                eprintln!("relay connection {peer_address} closed: {error:#}");
            }
        });
    }
}

async fn serve_connection(
    stream: tokio::net::TcpStream,
    token: String,
    networking: Arc<TcpEgressNetworking>,
    max_frame_bytes: usize,
) -> anyhow::Result<()> {
    let expected_protocol = format!("{CAPABILITY_PROTOCOL_PREFIX}{token}");
    let response_protocol = HeaderValue::from_str(&expected_protocol)?;
    let websocket = accept_hdr_async_with_config(
        stream,
        move |request: &Request, mut response: Response| {
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
        },
        Some(WebSocketConfig {
            max_message_size: Some(max_frame_bytes),
            max_frame_size: Some(max_frame_bytes),
            ..WebSocketConfig::default()
        }),
    )
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

fn parse_bounded_usize(value: &str, label: &str, maximum: usize) -> anyhow::Result<usize> {
    let parsed = value
        .parse::<usize>()
        .with_context(|| format!("{label} must be an integer"))?;
    if parsed == 0 || parsed > maximum {
        bail!("{label} must be between 1 and {maximum}");
    }
    Ok(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        mem::MaybeUninit,
        sync::atomic::{AtomicBool, AtomicUsize, Ordering},
    };
    use virtual_net::{
        meta::{MessageRequest, MessageResponse, RequestType, ResponseType},
        ruleset::Direction,
        InterestHandler, InterestType, LoopbackNetworking, RemoteNetworkingClient,
        VirtualConnectedSocket,
    };

    #[derive(Clone, Debug, Default)]
    struct CollapsingReadableState {
        pushes: Arc<AtomicUsize>,
        readable: Arc<AtomicBool>,
    }

    impl CollapsingReadableState {
        fn pop(&self) -> bool {
            self.readable.swap(false, Ordering::SeqCst)
        }
    }

    #[derive(Debug)]
    struct CollapsingReadableHandler {
        state: CollapsingReadableState,
    }

    impl InterestHandler for CollapsingReadableHandler {
        fn push_interest(&mut self, interest: InterestType) {
            if interest == InterestType::Readable {
                self.state.readable.store(true, Ordering::SeqCst);
                self.state.pushes.fetch_add(1, Ordering::SeqCst);
            }
        }

        fn pop_interest(&mut self, interest: InterestType) -> bool {
            interest == InterestType::Readable && self.state.pop()
        }

        fn has_interest(&self, interest: InterestType) -> bool {
            interest == InterestType::Readable && self.state.readable.load(Ordering::SeqCst)
        }
    }

    #[test]
    fn exact_dns_rule_expands_only_to_the_granted_port() {
        let config = Config {
            listen: "127.0.0.1:18792".parse().unwrap(),
            allow: vec![("api.example.com".to_string(), 443)],
            allow_private_network: false,
            max_connections: DEFAULT_MAX_CONNECTIONS,
            max_frame_bytes: DEFAULT_MAX_FRAME_BYTES,
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
            max_connections: DEFAULT_MAX_CONNECTIONS,
            max_frame_bytes: DEFAULT_MAX_FRAME_BYTES,
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

    #[test]
    fn resource_limit_parser_rejects_zero_and_excessive_values() {
        assert_eq!(parse_bounded_usize("4", "--max-connections", 8).unwrap(), 4);
        assert!(parse_bounded_usize("0", "--max-connections", 8).is_err());
        assert!(parse_bounded_usize("9", "--max-connections", 8).is_err());
        assert!(parse_bounded_usize("nope", "--max-connections", 8).is_err());
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

    #[tokio::test]
    async fn queued_remote_tcp_frames_rearm_collapsed_readiness_and_preserve_eof() {
        let (request_tx, mut request_rx) = mpsc::channel::<MessageRequest>(100);
        let (response_tx, response_rx) = mpsc::channel::<MessageResponse>(100);
        let (client, driver) = RemoteNetworkingClient::new_from_mpsc(request_tx, response_rx);
        let driver = tokio::spawn(driver);
        let connect_response_tx = response_tx.clone();
        let (socket_id_tx, socket_id_rx) = tokio::sync::oneshot::channel();
        let connect_responder = tokio::spawn(async move {
            let request = request_rx.recv().await.unwrap();
            let MessageRequest::Interface {
                req:
                    RequestType::ConnectTcp {
                        socket_id,
                        addr: _,
                        peer: _,
                    },
                req_id: Some(req_id),
            } = request
            else {
                panic!("expected a remote TCP connect request");
            };
            socket_id_tx.send(socket_id).unwrap();
            connect_response_tx
                .send(MessageResponse::ResponseToRequest {
                    req_id,
                    res: ResponseType::Socket(socket_id),
                })
                .await
                .unwrap();
        });
        let mut socket = client
            .connect_tcp(
                "0.0.0.0:0".parse().unwrap(),
                "127.0.0.1:18794".parse().unwrap(),
            )
            .await
            .unwrap();
        connect_responder.await.unwrap();

        let state = CollapsingReadableState::default();
        socket
            .set_handler(Box::new(CollapsingReadableHandler {
                state: state.clone(),
            }))
            .unwrap();
        let socket_id = socket_id_rx.await.unwrap();
        for data in [b"assistant".to_vec(), b"finish".to_vec(), Vec::new()] {
            response_tx
                .send(MessageResponse::Recv { socket_id, data })
                .await
                .unwrap();
        }
        for _ in 0..10_000 {
            if state.pushes.load(Ordering::SeqCst) >= 3 {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert_eq!(state.pushes.load(Ordering::SeqCst), 3);
        assert!(state.pop());

        let mut buffer = [MaybeUninit::<u8>::uninit(); 16];
        let first = socket.try_recv(&mut buffer, false).unwrap();
        assert_eq!(assume_initialized(&buffer[..first]), b"assistant");
        assert!(state.pop(), "queued finish frame did not rearm readable");

        let second = socket.try_recv(&mut buffer, false).unwrap();
        assert_eq!(assume_initialized(&buffer[..second]), b"finish");
        assert!(state.pop(), "queued EOF frame did not rearm readable");
        assert_eq!(socket.try_recv(&mut buffer, false).unwrap(), 0);

        driver.abort();
    }

    #[tokio::test]
    async fn partial_loopback_read_rearms_level_readiness() {
        let networking = LoopbackNetworking::default();
        let address = "127.0.0.1:18789".parse().unwrap();
        let mut listener = networking
            .listen_tcp(address, false, false, false)
            .await
            .unwrap();
        let mut sender = networking
            .loopback_connect_to("127.0.0.100:18789".parse().unwrap(), address)
            .unwrap();
        let (mut receiver, _) = listener.try_accept().unwrap();
        let state = CollapsingReadableState::default();
        receiver
            .set_handler(Box::new(CollapsingReadableHandler {
                state: state.clone(),
            }))
            .unwrap();

        assert_eq!(sender.try_send(b"assistant-finish").unwrap(), 16);
        assert!(state.pop());
        let mut buffer = [MaybeUninit::<u8>::uninit(); 9];
        let first = receiver.try_recv(&mut buffer, false).unwrap();
        assert_eq!(assume_initialized(&buffer[..first]), b"assistant");
        assert!(
            state.pop(),
            "remaining loopback bytes did not rearm readable"
        );
        let second = receiver.try_recv(&mut buffer, false).unwrap();
        assert_eq!(assume_initialized(&buffer[..second]), b"-finish");
    }

    fn assume_initialized(bytes: &[MaybeUninit<u8>]) -> &[u8] {
        unsafe { std::slice::from_raw_parts(bytes.as_ptr().cast(), bytes.len()) }
    }
}
