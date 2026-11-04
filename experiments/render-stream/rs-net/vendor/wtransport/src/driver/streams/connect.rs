use tracing::debug;
use wtransport_proto::bytes::IoReadError;
use wtransport_proto::capsule::capsules;
use wtransport_proto::capsule::Capsule;
use wtransport_proto::capsule::{self};
use wtransport_proto::error::ErrorCode;
use wtransport_proto::frame::Frame;
use wtransport_proto::frame::FrameKind;
use wtransport_proto::varint::VarInt;

use super::session::StreamSession;
use super::ProtoReadError;
use crate::driver::DriverError;
use crate::error::ApplicationClose;
use std::future::pending;

pub struct ConnectStream {
    stream: Option<StreamSession>,
}

impl ConnectStream {
    pub fn empty() -> Self {
        Self { stream: None }
    }

    pub fn is_empty(&self) -> bool {
        self.stream.is_none()
    }

    pub fn set_stream(&mut self, stream: StreamSession) {
        self.stream = Some(stream);
    }

    /// render-stream patch: writes CLOSE_WEBTRANSPORT_SESSION(error_code, reason) (reason
    /// truncated to the capsule's 1024 bytes) and finishes the CONNECT stream, waiting for the
    /// peer to acknowledge it. A no-op when there is no session stream.
    pub async fn close_session(&mut self, error_code: u32, reason: &[u8]) {
        let Some(mut stream) = self.stream.take() else {
            return;
        };
        let reason = &reason[..reason.len().min(1024)];
        let mut payload = Vec::with_capacity(4 + reason.len());
        payload.extend_from_slice(&error_code.to_be_bytes());
        payload.extend_from_slice(reason);
        // Capsule: type 0x2843 (two-byte varint 0x6843), length varint, payload.
        let mut capsule = Vec::with_capacity(2 + 8 + payload.len());
        capsule.extend_from_slice(&[0x68, 0x43]);
        let len = payload.len() as u64;
        if len < 64 {
            capsule.push(len as u8);
        } else {
            capsule.extend_from_slice(&(0x4000u16 | len as u16).to_be_bytes());
        }
        capsule.extend_from_slice(&payload);
        if stream
            .write_frame(Frame::new_data(capsule.into()))
            .await
            .is_ok()
        {
            stream.finish().await;
        }
    }

    pub async fn run(&mut self) -> DriverError {
        let stream = match self.stream.as_mut() {
            Some(stream) => stream,
            None => pending().await,
        };

        loop {
            return match stream.read_frame().await {
                Ok(frame) => {
                    if !matches!(frame.kind(), FrameKind::Data) {
                        debug!("Skipping non-data frame of kind {:?}", frame.kind());
                        continue;
                    }

                    let capsule = match Capsule::with_frame(&frame) {
                        Some(capsule)
                            if matches!(
                                capsule.kind(),
                                capsule::CapsuleKind::CloseWebTransportSession
                            ) =>
                        {
                            capsule
                        }
                        // Unknown capsule, skip it
                        _ => {
                            debug!(
                                "Unknown capsule of kind {:?} of {}B",
                                frame.kind(),
                                frame.payload().len()
                            );

                            continue;
                        }
                    };

                    let close_session =
                        match capsules::CloseWebTransportSession::with_capsule(&capsule) {
                            Ok(close_session) => close_session,
                            Err(error_code) => return DriverError::Proto(error_code),
                        };

                    // reset right away to avoid receiving additional data which requires resetting with ErrorCode::Message.
                    self.stream
                        .take()
                        .unwrap()
                        .reset(ErrorCode::NoError.to_code());

                    DriverError::ApplicationClosed(ApplicationClose::new(
                        close_session.error_code(),
                        close_session
                            .reason()
                            .as_bytes()
                            .to_vec()
                            .into_boxed_slice(),
                    ))
                }
                Err(ProtoReadError::H3(error_code)) => DriverError::Proto(error_code),
                Err(ProtoReadError::IO(io_error)) => match io_error {
                    // Cleanly terminating a CONNECT stream without a CLOSE_WEBTRANSPORT_SESSION
                    // capsule SHALL be semantically equivalent to terminating it with a
                    // CLOSE_WEBTRANSPORT_SESSION capsule that has an error code of 0 and an empty error string.
                    IoReadError::ImmediateFin => DriverError::ApplicationClosed(
                        ApplicationClose::new(VarInt::from_u32(0), Box::new([])),
                    ),
                    IoReadError::UnexpectedFin | IoReadError::Reset => {
                        DriverError::Proto(ErrorCode::ClosedCriticalStream)
                    }
                    IoReadError::NotConnected => DriverError::NotConnected,
                },
            };
        }
    }
}
