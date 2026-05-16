use tracing::info;

pub mod room;
pub mod server;
pub mod types;
pub mod ws;

/// Start the EchoMesh signaling server on the provided socket address.
pub async fn run_signaling_server(addr: &str) -> std::io::Result<()> {
    let room_manager = room::manager::RoomManager::new();
    let app = server::create_router(room_manager);

    info!("EchoMesh signaling server listening on {addr}");

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await
}
