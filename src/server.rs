use axum::Router;
use axum::response::Html;
use tower_http::cors::{Any, CorsLayer};

use crate::room::manager::RoomManager;
use crate::ws::handler::ws_upgrade;

/// Build the Axum application router.
///
/// Routes:
/// - `GET /ws` — WebSocket upgrade for signaling
///
/// Middleware:
/// - CORS (permissive for development; restrict in production)
pub fn create_router(room_manager: RoomManager) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    Router::new()
        .route("/ws", axum::routing::get(ws_upgrade))
        .route("/test", axum::routing::get(serve_test_page))
        .route("/healthz", axum::routing::get(health_check))
        .layer(cors)
        .with_state(room_manager)
}

async fn health_check() -> &'static str {
    "ok"
}

/// Serve the test page for manual signaling verification.
async fn serve_test_page() -> Html<&'static str> {
    Html(include_str!("../test.html"))
}
