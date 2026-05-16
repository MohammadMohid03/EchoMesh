use tracing_subscriber::EnvFilter;

pub fn run() {
    init_logging();

    tauri::Builder::default()
        .setup(|_app| {
            tauri::async_runtime::spawn(async {
                if let Err(err) = echomesh::run_signaling_server("0.0.0.0:8080").await {
                    eprintln!("EchoMesh embedded signaling server did not start: {err}");
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running EchoMesh desktop app");
}

fn init_logging() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("echomesh=info")),
        )
        .try_init();
}
