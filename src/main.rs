use tracing::info;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() {
    // Initialize structured logging.
    // Default: show info-level logs from echomesh.
    // Override with RUST_LOG env var (e.g., RUST_LOG=echomesh=debug).
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("echomesh=info")),
        )
        .init();

    let port = std::env::var("PORT").unwrap_or_else(|_| "8080".to_string());
    let addr = format!("0.0.0.0:{port}");
    info!(addr = %addr, "Starting EchoMesh signaling server");
    echomesh::run_signaling_server(&addr)
        .await
        .expect("Server error");
}
