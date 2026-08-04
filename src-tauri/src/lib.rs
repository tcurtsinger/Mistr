pub mod acquisition;
pub mod chunk_assembly;
pub mod live_pipeline;
pub mod mrms;
pub mod national_phase2;
pub mod packed_grid;
pub mod packed_sweep;
mod phase2_ipc;
pub mod radar;

use tauri::{Manager, webview::PageLoadEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(phase2_ipc::TransferBroker::default())
        .manage(national_phase2::NationalPhase2State::default())
        .setup(|app| {
            let resource_root = app.path().resource_dir()?;
            app.manage(phase2_ipc::RuntimeResources::new(resource_root));
            Ok(())
        })
        .on_page_load(|webview, payload| {
            if payload.event() == PageLoadEvent::Started
                && let Err(error) = webview
                    .state::<phase2_ipc::TransferBroker>()
                    .document_started()
            {
                eprintln!(
                    "failed to advance transfer document epoch: {}",
                    error.message
                );
            }
        })
        .invoke_handler(tauri::generate_handler![
            phase2_ipc::open_phase2_transfer_session,
            phase2_ipc::begin_phase2_generation,
            phase2_ipc::cancel_phase2_generation,
            phase2_ipc::release_phase2_transfer_credit,
            phase2_ipc::phase2_transfer_snapshot,
            phase2_ipc::phase4_activity_snapshot,
            phase2_ipc::phase5_live_evidence,
            phase2_ipc::request_phase2_benchmark_sweep,
            phase2_ipc::request_phase3_fixture_sweep,
            phase2_ipc::request_phase4_fixture_sweep,
            phase2_ipc::request_phase6_n0s_fixture_sweep,
            phase2_ipc::request_phase5_live_sweep,
            phase2_ipc::benchmark_phase2_encoder,
            national_phase2::prepare_national_phase2_diagnostic,
            national_phase2::prepare_national_phase3_frame,
            national_phase2::request_national_packed_grid_manifest,
            national_phase2::request_national_packed_grid_chunk,
            national_phase2::lookup_national_grid_point,
            national_phase2::find_national_peak_point,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Mistr");
}
