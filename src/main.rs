use tracing::info;
use tracing_subscriber::EnvFilter;

mod room;
mod server;
mod types;
mod ws;

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

    let room_manager = room::manager::RoomManager::new();
    let app = server::create_router(room_manager);

    let addr = "0.0.0.0:8080";
    info!("EchoMesh signaling server listening on {addr}");

    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("Failed to bind to address");

    axum::serve(listener, app)
        .await
        .expect("Server error");
}
