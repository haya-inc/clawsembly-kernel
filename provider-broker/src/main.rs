use std::{
    env,
    net::{IpAddr, SocketAddr},
    str::FromStr,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

use anyhow::{Context, bail};
use axum::{
    Router,
    body::{Body, Bytes},
    extract::{DefaultBodyLimit, State},
    http::{
        HeaderMap, HeaderValue, StatusCode,
        header::{ACCEPT, AUTHORIZATION, CACHE_CONTROL, CONTENT_TYPE},
    },
    response::{IntoResponse, Response},
    routing::post,
};
use futures_util::{Stream, StreamExt, TryStreamExt};
use reqwest::{Client, Url, redirect, tls};
use serde_json::{Value, json};
use subtle::ConstantTimeEq;
use tokio::{
    net::TcpListener,
    sync::{OwnedSemaphorePermit, Semaphore},
};
use zeroize::Zeroize;

const BROKER_PATH: &str = "/v1/chat/completions";
const DEFAULT_LISTEN: &str = "127.0.0.1:18794";
const DEFAULT_MODEL: &str = "openai/gpt-4o";
const DEFAULT_UPSTREAM: &str = "https://models.github.ai/inference/chat/completions";
const MAX_REQUEST_BYTES: usize = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;

struct Secret(String);

impl Secret {
    fn expose(&self) -> &str {
        &self.0
    }
}

impl Drop for Secret {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

struct Config {
    broker_token: Secret,
    listen: SocketAddr,
    max_requests: u64,
    model: String,
    provider_api_key: Secret,
    upstream: Url,
}

impl Config {
    fn parse() -> anyhow::Result<Self> {
        let mut listen = SocketAddr::from_str(DEFAULT_LISTEN).unwrap();
        let mut max_requests = 100_u64;
        let mut model = DEFAULT_MODEL.to_string();
        let mut upstream = Url::parse(DEFAULT_UPSTREAM).unwrap();
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
                "--max-requests" => {
                    max_requests = args
                        .next()
                        .context("--max-requests requires an integer")?
                        .parse()
                        .context("--max-requests must be an integer")?;
                }
                "--model" => {
                    model = args.next().context("--model requires a value")?;
                }
                "--upstream" => {
                    upstream = Url::parse(&args.next().context("--upstream requires a URL")?)
                        .context("--upstream must be an absolute URL")?;
                }
                "--help" | "-h" => {
                    println!(
                        "Usage: clawsembly-provider-broker \\
                         [--listen 127.0.0.1:18794] \\
                         [--upstream HTTPS_URL] [--model MODEL_ID] \\
                         [--max-requests COUNT]\n\n\
                         Set CLAWSEMBLY_PROVIDER_BROKER_TOKEN to the opaque \\
                         guest capability and CLAWSEMBLY_PROVIDER_API_KEY to \\
                         the provider credential."
                    );
                    std::process::exit(0);
                }
                unknown => bail!("unknown argument: {unknown}"),
            }
        }

        validate_listen(listen)?;
        validate_upstream(&upstream)?;
        validate_model(&model)?;
        if !(1..=10_000).contains(&max_requests) {
            bail!("--max-requests must be between 1 and 10000");
        }
        let broker_token = env::var("CLAWSEMBLY_PROVIDER_BROKER_TOKEN")
            .context("CLAWSEMBLY_PROVIDER_BROKER_TOKEN is required")?;
        validate_capability_token(&broker_token)?;
        let provider_api_key = env::var("CLAWSEMBLY_PROVIDER_API_KEY")
            .context("CLAWSEMBLY_PROVIDER_API_KEY is required")?;
        validate_provider_api_key(&provider_api_key)?;

        Ok(Self {
            broker_token: Secret(broker_token),
            listen,
            max_requests,
            model,
            provider_api_key: Secret(provider_api_key),
            upstream,
        })
    }
}

struct BrokerState {
    broker_token: Secret,
    client: Client,
    concurrent_request: Arc<Semaphore>,
    max_requests: u64,
    model: String,
    provider_api_key: Secret,
    request_count: AtomicU64,
    request_sequence: AtomicU64,
    upstream: Url,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let config = Config::parse()?;
    let client = Client::builder()
        .https_only(true)
        .min_tls_version(tls::Version::TLS_1_2)
        .connect_timeout(Duration::from_secs(10))
        .read_timeout(Duration::from_secs(90))
        .timeout(Duration::from_secs(120))
        .redirect(redirect::Policy::none())
        .no_proxy()
        .user_agent(concat!(
            "clawsembly-provider-broker/",
            env!("CARGO_PKG_VERSION")
        ))
        .build()
        .context("failed to build provider HTTPS client")?;
    let listen = config.listen;
    let authority = upstream_authority(&config.upstream);
    let model = config.model.clone();
    let max_requests = config.max_requests;
    let state = Arc::new(BrokerState {
        broker_token: config.broker_token,
        client,
        concurrent_request: Arc::new(Semaphore::new(1)),
        max_requests,
        model: config.model,
        provider_api_key: config.provider_api_key,
        request_count: AtomicU64::new(0),
        request_sequence: AtomicU64::new(0),
        upstream: config.upstream,
    });
    let app = Router::new()
        .route(BROKER_PATH, post(chat_completions))
        .layer(DefaultBodyLimit::max(MAX_REQUEST_BYTES))
        .with_state(state);
    let listener = TcpListener::bind(listen)
        .await
        .with_context(|| format!("failed to listen on {listen}"))?;
    let local_address = listener.local_addr()?;

    println!(
        "{}",
        json!({
            "status": "ready",
            "listen": local_address.to_string(),
            "path": BROKER_PATH,
            "upstreamAuthority": authority,
            "model": model,
            "maxRequestBytes": MAX_REQUEST_BYTES,
            "maxResponseBytes": MAX_RESPONSE_BYTES,
            "maxRequests": max_requests,
            "maxConcurrency": 1,
            "providerCredentialRecorded": false
        })
    );
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("provider broker server failed")
}

async fn chat_completions(
    State(state): State<Arc<BrokerState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let request_id = state.request_sequence.fetch_add(1, Ordering::Relaxed) + 1;
    if !authorized(&headers, state.broker_token.expose()) {
        return error_response(StatusCode::UNAUTHORIZED, "unauthorized");
    }
    let Ok(permit) = state.concurrent_request.clone().try_acquire_owned() else {
        return error_response(StatusCode::TOO_MANY_REQUESTS, "concurrent_request");
    };
    let request_number = state.request_count.fetch_add(1, Ordering::AcqRel) + 1;
    if request_number > state.max_requests {
        return error_response(StatusCode::TOO_MANY_REQUESTS, "request_budget_exhausted");
    }
    if !is_json_content_type(&headers) {
        return error_response(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "content_type_must_be_application_json",
        );
    }
    if let Err(code) = validate_request_body(&body, &state.model) {
        return error_response(StatusCode::BAD_REQUEST, code);
    }

    let started = Instant::now();
    let request = match build_provider_request(&state, body) {
        Ok(request) => request,
        Err(()) => {
            return error_response(StatusCode::BAD_GATEWAY, "upstream_request_build_failed");
        }
    };
    let upstream = state.client.execute(request).await;
    let upstream = match upstream {
        Ok(response) => response,
        Err(error) => {
            eprintln!(
                "{}",
                json!({
                    "status": "upstream-error",
                    "requestId": request_id,
                    "timeout": error.is_timeout(),
                    "connect": error.is_connect(),
                    "request": error.is_request(),
                    "providerCredentialRecorded": false
                })
            );
            return error_response(StatusCode::BAD_GATEWAY, "upstream_request_failed");
        }
    };

    let status = upstream.status();
    let content_type = upstream.headers().get(CONTENT_TYPE).cloned();
    println!(
        "{}",
        json!({
            "status": "upstream-response",
            "requestId": request_id,
            "requestNumber": request_number,
            "httpStatus": status.as_u16(),
            "elapsedMs": started.elapsed().as_millis(),
            "model": state.model,
            "stream": true,
            "providerCredentialRecorded": false,
            "requestBodyRecorded": false
        })
    );
    let mut response = Response::builder()
        .status(status)
        .header(CACHE_CONTROL, "no-store");
    if let Some(content_type) = content_type {
        response = response.header(CONTENT_TYPE, content_type);
    }
    response
        .body(Body::from_stream(guarded_provider_stream(upstream, permit)))
        .unwrap_or_else(|_| error_response(StatusCode::BAD_GATEWAY, "response_build_failed"))
}

fn build_provider_request(state: &BrokerState, body: Bytes) -> Result<reqwest::Request, ()> {
    state
        .client
        .post(state.upstream.clone())
        .bearer_auth(state.provider_api_key.expose())
        .header(CONTENT_TYPE, "application/json")
        .header(ACCEPT, "text/event-stream")
        .body(body)
        .build()
        .map_err(|_| ())
}

fn guarded_provider_stream(
    upstream: reqwest::Response,
    permit: OwnedSemaphorePermit,
) -> impl Stream<Item = anyhow::Result<Bytes>> {
    let mut upstream_stream = upstream.bytes_stream().map_err(anyhow::Error::from);
    async_stream::try_stream! {
        let _permit = permit;
        let mut response_bytes = 0_usize;
        while let Some(chunk) = upstream_stream.next().await {
            let chunk = chunk?;
            response_bytes = response_bytes
                .checked_add(chunk.len())
                .context("provider response length overflow")?;
            if response_bytes > MAX_RESPONSE_BYTES {
                Err(anyhow::anyhow!(
                    "provider response exceeded capability limit"
                ))?;
            }
            yield chunk;
        }
    }
}

fn authorized(headers: &HeaderMap, expected_token: &str) -> bool {
    let Some(candidate) = headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
    else {
        return false;
    };
    candidate.len() == expected_token.len()
        && bool::from(candidate.as_bytes().ct_eq(expected_token.as_bytes()))
}

fn is_json_content_type(headers: &HeaderMap) -> bool {
    headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("application/json"))
}

fn validate_request_body(body: &[u8], expected_model: &str) -> Result<(), &'static str> {
    let value: Value = serde_json::from_slice(body).map_err(|_| "invalid_json")?;
    let object = value.as_object().ok_or("body_must_be_object")?;
    if object.get("model").and_then(Value::as_str) != Some(expected_model) {
        return Err("model_not_granted");
    }
    if object.get("stream").and_then(Value::as_bool) != Some(true) {
        return Err("streaming_required");
    }
    let Some(messages) = object.get("messages").and_then(Value::as_array) else {
        return Err("messages_required");
    };
    if messages.is_empty() {
        return Err("messages_required");
    }
    Ok(())
}

fn error_response(status: StatusCode, code: &'static str) -> Response {
    let body = Body::from(
        json!({
            "error": {
                "type": "clawsembly_capability_error",
                "code": code
            }
        })
        .to_string(),
    );
    Response::builder()
        .status(status)
        .header(CONTENT_TYPE, HeaderValue::from_static("application/json"))
        .header(CACHE_CONTROL, HeaderValue::from_static("no-store"))
        .body(body)
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

fn validate_listen(listen: SocketAddr) -> anyhow::Result<()> {
    if !listen.ip().is_loopback() {
        bail!("--listen must use a loopback IP address");
    }
    if listen.port() == 0 {
        bail!("--listen port must be between 1 and 65535");
    }
    Ok(())
}

fn validate_upstream(upstream: &Url) -> anyhow::Result<()> {
    if upstream.scheme() != "https" {
        bail!("--upstream must use https");
    }
    if !upstream.username().is_empty()
        || upstream.password().is_some()
        || upstream.query().is_some()
        || upstream.fragment().is_some()
    {
        bail!("--upstream may not contain credentials, query, or fragment");
    }
    if upstream.port_or_known_default() != Some(443) {
        bail!("--upstream must use port 443");
    }
    let Some(host) = upstream.host_str() else {
        bail!("--upstream must use an exact DNS name");
    };
    if host.is_empty() || host.parse::<IpAddr>().is_ok() {
        bail!("--upstream must use an exact DNS name");
    }
    if upstream.path() == "/" || upstream.path().ends_with('/') {
        bail!("--upstream must name one exact completion endpoint");
    }
    Ok(())
}

fn upstream_authority(upstream: &Url) -> String {
    format!(
        "{}:{}",
        upstream.host_str().unwrap_or_default(),
        upstream.port_or_known_default().unwrap_or_default()
    )
}

fn validate_model(model: &str) -> anyhow::Result<()> {
    if model.is_empty()
        || model.len() > 200
        || model.bytes().any(|byte| {
            !(byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'/'))
        })
    {
        bail!("--model must be a 1-200 character model identifier");
    }
    Ok(())
}

fn validate_capability_token(token: &str) -> anyhow::Result<()> {
    if token.is_empty()
        || token.len() > 128
        || !token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        bail!("broker capability token must be 1-128 URL-safe characters");
    }
    Ok(())
}

fn validate_provider_api_key(api_key: &str) -> anyhow::Result<()> {
    if api_key.is_empty()
        || api_key.len() > 4_096
        || !api_key.bytes().all(|byte| byte.is_ascii_graphic())
    {
        bail!("CLAWSEMBLY_PROVIDER_API_KEY must be 1-4096 visible ASCII characters");
    }
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut signal) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            signal.recv().await;
        } else {
            std::future::pending::<()>().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn listen_must_be_loopback() {
        assert!(validate_listen("127.0.0.1:18794".parse().unwrap()).is_ok());
        assert!(validate_listen("[::1]:18794".parse().unwrap()).is_ok());
        assert!(validate_listen("0.0.0.0:18794".parse().unwrap()).is_err());
    }

    #[test]
    fn upstream_must_be_one_https_dns_endpoint() {
        assert!(validate_upstream(&Url::parse(DEFAULT_UPSTREAM).unwrap()).is_ok());
        for denied in [
            "http://models.github.ai/inference/chat/completions",
            "https://127.0.0.1/inference/chat/completions",
            "https://token@models.github.ai/inference/chat/completions",
            "https://models.github.ai/inference/chat/completions?target=other",
            "https://models.github.ai/",
        ] {
            assert!(validate_upstream(&Url::parse(denied).unwrap()).is_err());
        }
    }

    #[test]
    fn authorization_is_exact_and_bearer_scoped() {
        let mut headers = HeaderMap::new();
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_static("Bearer exact-token"),
        );
        assert!(authorized(&headers, "exact-token"));
        assert!(!authorized(&headers, "other-token"));
        headers.insert(AUTHORIZATION, HeaderValue::from_static("Basic exact-token"));
        assert!(!authorized(&headers, "exact-token"));
    }

    #[test]
    fn request_is_bound_to_model_streaming_and_messages() {
        let allowed = json!({
            "model": DEFAULT_MODEL,
            "stream": true,
            "messages": [{"role": "user", "content": "hello"}]
        });
        assert!(
            validate_request_body(&serde_json::to_vec(&allowed).unwrap(), DEFAULT_MODEL).is_ok()
        );
        for denied in [
            json!({"model": "other", "stream": true, "messages": [{}]}),
            json!({"model": DEFAULT_MODEL, "stream": false, "messages": [{}]}),
            json!({"model": DEFAULT_MODEL, "stream": true, "messages": []}),
        ] {
            assert!(
                validate_request_body(&serde_json::to_vec(&denied).unwrap(), DEFAULT_MODEL)
                    .is_err()
            );
        }
    }

    #[test]
    fn capability_tokens_are_narrow_ascii_protocol_values() {
        assert!(validate_capability_token("broker-capability_1").is_ok());
        assert!(validate_capability_token("").is_err());
        assert!(validate_capability_token("contains space").is_err());
        assert!(validate_capability_token("contains/slash").is_err());
    }

    #[test]
    fn provider_keys_must_be_safe_bearer_header_values() {
        assert!(validate_provider_api_key("github-token_123").is_ok());
        assert!(validate_provider_api_key("").is_err());
        assert!(validate_provider_api_key("contains space").is_err());
        assert!(validate_provider_api_key("contains\nnewline").is_err());
        assert!(validate_provider_api_key("unicode-\u{2603}").is_err());
    }

    #[test]
    fn secret_redacts_debug_by_not_implementing_it_and_zeroizes_on_drop() {
        let secret = Secret("provider-secret".to_string());
        assert_eq!(secret.expose(), "provider-secret");
    }

    #[test]
    fn provider_request_replaces_guest_authority_with_the_host_secret() {
        let state = BrokerState {
            broker_token: Secret("guest-capability".to_string()),
            client: Client::builder().no_proxy().build().unwrap(),
            concurrent_request: Arc::new(Semaphore::new(1)),
            max_requests: 1,
            model: DEFAULT_MODEL.to_string(),
            provider_api_key: Secret("host-provider-secret".to_string()),
            request_count: AtomicU64::new(0),
            request_sequence: AtomicU64::new(0),
            upstream: Url::parse(DEFAULT_UPSTREAM).unwrap(),
        };
        let body =
            Bytes::from_static(br#"{"model":"openai/gpt-4o","stream":true,"messages":[{}]}"#);
        let request = build_provider_request(&state, body.clone()).unwrap();
        assert_eq!(request.url().as_str(), DEFAULT_UPSTREAM);
        assert_eq!(
            request.headers().get(AUTHORIZATION).unwrap(),
            "Bearer host-provider-secret"
        );
        assert_ne!(
            request.headers().get(AUTHORIZATION).unwrap(),
            "Bearer guest-capability"
        );
        assert_eq!(
            request.headers().get(CONTENT_TYPE).unwrap(),
            "application/json"
        );
        assert_eq!(request.headers().get(ACCEPT).unwrap(), "text/event-stream");
        assert_eq!(
            request.body().and_then(reqwest::Body::as_bytes),
            Some(&body[..])
        );
    }
}
