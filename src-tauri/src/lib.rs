pub mod packed_sweep;
mod phase2_ipc;
pub mod radar;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(phase2_ipc::TransferBroker::default())
        .invoke_handler(tauri::generate_handler![
            phase2_ipc::begin_phase2_generation,
            phase2_ipc::cancel_phase2_generation,
            phase2_ipc::release_phase2_transfer_credit,
            phase2_ipc::phase2_transfer_snapshot,
            phase2_ipc::request_phase2_benchmark_sweep,
            phase2_ipc::benchmark_phase2_encoder,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Mistr");
}
