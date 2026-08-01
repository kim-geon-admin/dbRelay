pub mod application;
pub mod commands;
pub mod connectors;
pub mod domain;
pub mod infrastructure;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir()?;
            let container = commands::ApplicationContainer::for_desktop(app_data_dir)?;
            app.manage(container);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::connections::list_connections,
            commands::connections::save_connection,
            commands::connections::update_connection,
            commands::connections::disable_connection,
            commands::connections::test_connection,
            commands::flows::list_flows,
            commands::flows::save_flow,
            commands::flows::duplicate_flow,
            commands::runs::start_run,
            commands::runs::recover_run,
            commands::history::list_run_history,
        ])
        .run(tauri::generate_context!())
        .expect("error while running DB Relay");
}
