//! Mistr-owned state machine for the public real-time Level II chunk bucket.
//!
//! Object listing and download are deliberately separate from this module. The
//! assembler accepts only bounded, already-downloaded chunks and owns every
//! transition that can make bytes eligible for decoding.

use chrono::NaiveDateTime;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use thiserror::Error;

pub const MAX_REALTIME_CHUNK_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_REALTIME_VOLUME_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_REALTIME_CHUNKS: u16 = 256;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChunkKind {
    Start,
    Intermediate,
    End,
}

impl ChunkKind {
    fn parse(value: &str) -> Result<Self, ChunkAssemblyError> {
        match value {
            "S" => Ok(Self::Start),
            "I" => Ok(Self::Intermediate),
            "E" => Ok(Self::End),
            _ => Err(ChunkAssemblyError::InvalidObjectKey(
                "chunk type must be S, I, or E".into(),
            )),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChunkMetadata {
    pub site: String,
    pub volume_index: u16,
    pub volume_started_at_unix_ms: i64,
    pub sequence: u16,
    pub kind: ChunkKind,
    pub key: String,
    pub last_modified_unix_ms: i64,
    pub size_bytes: usize,
    pub etag: Option<String>,
}

impl ChunkMetadata {
    pub fn from_s3_object(
        expected_site: &str,
        key: &str,
        last_modified_unix_ms: i64,
        size_bytes: usize,
        etag: Option<String>,
    ) -> Result<Self, ChunkAssemblyError> {
        validate_site(expected_site)?;
        let mut path = key.split('/');
        let site = path.next().unwrap_or_default();
        let volume = path.next().unwrap_or_default();
        let name = path.next().unwrap_or_default();
        if path.next().is_some() || site != expected_site || name.is_empty() {
            return Err(ChunkAssemblyError::InvalidObjectKey(format!(
                "object key {key:?} is not inside {expected_site}/<volume>/"
            )));
        }
        let volume_index = volume.parse::<u16>().map_err(|_| {
            ChunkAssemblyError::InvalidObjectKey("volume index is not numeric".into())
        })?;
        if !(1..=999).contains(&volume_index) {
            return Err(ChunkAssemblyError::InvalidObjectKey(
                "volume index must be in 1..=999".into(),
            ));
        }

        let fields = name.split('-').collect::<Vec<_>>();
        if fields.len() != 4
            || fields[0].len() != 8
            || fields[1].len() != 6
            || fields[2].len() != 3
            || fields[3].len() != 1
        {
            return Err(ChunkAssemblyError::InvalidObjectKey(format!(
                "chunk name {name:?} does not match YYYYMMDD-HHMMSS-NNN-T"
            )));
        }
        let volume_started =
            NaiveDateTime::parse_from_str(&format!("{}-{}", fields[0], fields[1]), "%Y%m%d-%H%M%S")
                .map_err(|_| {
                    ChunkAssemblyError::InvalidObjectKey("chunk timestamp is invalid UTC".into())
                })?;
        let sequence = fields[2].parse::<u16>().map_err(|_| {
            ChunkAssemblyError::InvalidObjectKey("chunk sequence is not numeric".into())
        })?;
        if !(1..=MAX_REALTIME_CHUNKS).contains(&sequence) {
            return Err(ChunkAssemblyError::InvalidObjectKey(format!(
                "chunk sequence must be in 1..={MAX_REALTIME_CHUNKS}"
            )));
        }
        let kind = ChunkKind::parse(fields[3])?;
        if size_bytes == 0 || size_bytes > MAX_REALTIME_CHUNK_BYTES {
            return Err(ChunkAssemblyError::ChunkSizeOutOfBounds {
                actual: size_bytes,
                limit: MAX_REALTIME_CHUNK_BYTES,
            });
        }
        if last_modified_unix_ms <= 0 {
            return Err(ChunkAssemblyError::InvalidObjectMetadata(
                "last-modified timestamp must be positive".into(),
            ));
        }

        Ok(Self {
            site: site.into(),
            volume_index,
            volume_started_at_unix_ms: volume_started.and_utc().timestamp_millis(),
            sequence,
            kind,
            key: key.into(),
            last_modified_unix_ms,
            size_bytes,
            etag,
        })
    }

    fn volume_identity(&self) -> VolumeIdentity {
        VolumeIdentity {
            site: self.site.clone(),
            volume_index: self.volume_index,
            started_at_unix_ms: self.volume_started_at_unix_ms,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VolumeIdentity {
    pub site: String,
    pub volume_index: u16,
    pub started_at_unix_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct StoredChunk {
    metadata: ChunkMetadata,
    sha256: String,
    bytes: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ActiveVolume {
    identity: VolumeIdentity,
    chunks: BTreeMap<u16, StoredChunk>,
    terminal_sequence: Option<u16>,
    total_bytes: usize,
    safe_sweep_published: bool,
}

impl ActiveVolume {
    fn new(identity: VolumeIdentity) -> Self {
        Self {
            identity,
            chunks: BTreeMap::new(),
            terminal_sequence: None,
            total_bytes: 0,
            safe_sweep_published: false,
        }
    }

    fn contiguous_through(&self) -> u16 {
        let mut expected = 1u16;
        while self.chunks.contains_key(&expected) {
            if expected == MAX_REALTIME_CHUNKS {
                return expected;
            }
            expected += 1;
        }
        expected - 1
    }

    fn waiting_for_sequence(&self) -> Option<u16> {
        let contiguous = self.contiguous_through();
        self.chunks
            .keys()
            .next_back()
            .copied()
            .filter(|highest| *highest > contiguous.saturating_add(1))
            .map(|_| contiguous + 1)
    }

    fn complete(&self) -> bool {
        self.terminal_sequence
            .is_some_and(|terminal| self.contiguous_through() == terminal)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ChunkIngestOutcome {
    Accepted {
        volume: VolumeIdentity,
        contiguous_through: u16,
        waiting_for_sequence: Option<u16>,
        volume_complete: bool,
    },
    Duplicate {
        volume: VolumeIdentity,
        sequence: u16,
    },
    Late {
        active_volume: VolumeIdentity,
        ignored_key: String,
    },
    Rollover {
        volume: VolumeIdentity,
        abandoned_incomplete_volume: Option<VolumeIdentity>,
    },
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum ChunkAssemblyError {
    #[error("invalid radar site: {0}")]
    InvalidSite(String),
    #[error("invalid real-time object key: {0}")]
    InvalidObjectKey(String),
    #[error("invalid real-time object metadata: {0}")]
    InvalidObjectMetadata(String),
    #[error("chunk is {actual} bytes; limit is {limit} bytes")]
    ChunkSizeOutOfBounds { actual: usize, limit: usize },
    #[error("chunk declared {declared} bytes but download contained {actual} bytes")]
    ChunkLengthMismatch { declared: usize, actual: usize },
    #[error("chunk payload format does not match its declared type")]
    ChunkPayloadMismatch,
    #[error("generation {actual} is stale; active generation is {expected}")]
    StaleGeneration { actual: u64, expected: u64 },
    #[error("generation {0} is cancelled")]
    GenerationCancelled(u64),
    #[error("the first accepted chunk for a volume must be sequence 001-S")]
    StartChunkRequired,
    #[error("volume identity conflicts with another object at the same start time")]
    VolumeIdentityConflict,
    #[error("sequence {sequence} has conflicting content or metadata")]
    ConflictingDuplicate { sequence: u16 },
    #[error("chunk sequence/type is invalid: {0}")]
    InvalidSequence(String),
    #[error("assembled volume would exceed {limit} bytes")]
    VolumeTooLarge { limit: usize },
    #[error("no active real-time volume exists")]
    NoActiveVolume,
    #[error("a safe sweep was already published from the active volume")]
    SafeSweepAlreadyPublished,
    #[error("the active volume is not contiguous and complete")]
    VolumeIncomplete,
}

#[derive(Debug, Clone)]
pub struct ChunkAssembler {
    generation: u64,
    site: String,
    active: bool,
    volume: Option<ActiveVolume>,
}

impl ChunkAssembler {
    pub fn new(generation: u64, site: &str) -> Result<Self, ChunkAssemblyError> {
        if generation == 0 {
            return Err(ChunkAssemblyError::StaleGeneration {
                actual: 0,
                expected: 1,
            });
        }
        validate_site(site)?;
        Ok(Self {
            generation,
            site: site.into(),
            active: true,
            volume: None,
        })
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn cancel(&mut self) {
        self.active = false;
    }

    pub fn ingest(
        &mut self,
        generation: u64,
        metadata: ChunkMetadata,
        bytes: Vec<u8>,
    ) -> Result<ChunkIngestOutcome, ChunkAssemblyError> {
        self.ensure_current(generation)?;
        if metadata.site != self.site {
            return Err(ChunkAssemblyError::InvalidSite(format!(
                "chunk site {} does not match active site {}",
                metadata.site, self.site
            )));
        }
        if bytes.len() != metadata.size_bytes {
            return Err(ChunkAssemblyError::ChunkLengthMismatch {
                declared: metadata.size_bytes,
                actual: bytes.len(),
            });
        }
        validate_payload(metadata.kind, &bytes)?;
        validate_sequence_type(&metadata)?;

        let identity = metadata.volume_identity();
        let rollover = match &self.volume {
            None => {
                if metadata.sequence != 1 || metadata.kind != ChunkKind::Start {
                    return Err(ChunkAssemblyError::StartChunkRequired);
                }
                self.volume = Some(ActiveVolume::new(identity.clone()));
                None
            }
            Some(current) if current.identity == identity => None,
            Some(current) if current.identity.started_at_unix_ms == identity.started_at_unix_ms => {
                return Err(ChunkAssemblyError::VolumeIdentityConflict);
            }
            Some(current) if identity.started_at_unix_ms < current.identity.started_at_unix_ms => {
                return Ok(ChunkIngestOutcome::Late {
                    active_volume: current.identity.clone(),
                    ignored_key: metadata.key,
                });
            }
            Some(current) => {
                if metadata.sequence != 1 || metadata.kind != ChunkKind::Start {
                    return Err(ChunkAssemblyError::StartChunkRequired);
                }
                let abandoned = (!current.complete()).then(|| current.identity.clone());
                self.volume = Some(ActiveVolume::new(identity.clone()));
                Some(abandoned)
            }
        };

        let volume = self
            .volume
            .as_mut()
            .ok_or(ChunkAssemblyError::NoActiveVolume)?;
        if let Some(existing) = volume.chunks.get(&metadata.sequence) {
            let sha256 = format!("{:x}", Sha256::digest(&bytes));
            return if existing.metadata.kind == metadata.kind
                && existing.sha256 == sha256
                && existing.bytes == bytes
            {
                Ok(ChunkIngestOutcome::Duplicate {
                    volume: volume.identity.clone(),
                    sequence: metadata.sequence,
                })
            } else {
                Err(ChunkAssemblyError::ConflictingDuplicate {
                    sequence: metadata.sequence,
                })
            };
        }
        if let Some(terminal) = volume.terminal_sequence {
            if metadata.sequence > terminal {
                return Err(ChunkAssemblyError::InvalidSequence(format!(
                    "sequence {} follows terminal sequence {terminal}",
                    metadata.sequence
                )));
            }
            if metadata.kind == ChunkKind::End && metadata.sequence != terminal {
                return Err(ChunkAssemblyError::InvalidSequence(format!(
                    "terminal sequence changed from {terminal} to {}",
                    metadata.sequence
                )));
            }
        }
        if metadata.kind == ChunkKind::End {
            if volume
                .chunks
                .keys()
                .any(|sequence| *sequence > metadata.sequence)
            {
                return Err(ChunkAssemblyError::InvalidSequence(
                    "end chunk precedes an already accepted sequence".into(),
                ));
            }
            volume.terminal_sequence = Some(metadata.sequence);
        }
        let next_total = volume
            .total_bytes
            .checked_add(bytes.len())
            .filter(|total| *total <= MAX_REALTIME_VOLUME_BYTES)
            .ok_or(ChunkAssemblyError::VolumeTooLarge {
                limit: MAX_REALTIME_VOLUME_BYTES,
            })?;
        let sequence = metadata.sequence;
        let sha256 = format!("{:x}", Sha256::digest(&bytes));
        volume.chunks.insert(
            sequence,
            StoredChunk {
                metadata,
                sha256,
                bytes,
            },
        );
        volume.total_bytes = next_total;

        if let Some(abandoned_incomplete_volume) = rollover {
            return Ok(ChunkIngestOutcome::Rollover {
                volume: volume.identity.clone(),
                abandoned_incomplete_volume,
            });
        }
        Ok(ChunkIngestOutcome::Accepted {
            volume: volume.identity.clone(),
            contiguous_through: volume.contiguous_through(),
            waiting_for_sequence: volume.waiting_for_sequence(),
            volume_complete: volume.complete(),
        })
    }

    pub fn active_volume(&self) -> Option<&VolumeIdentity> {
        self.volume.as_ref().map(|volume| &volume.identity)
    }

    pub fn contiguous_through(&self) -> u16 {
        self.volume
            .as_ref()
            .map_or(0, ActiveVolume::contiguous_through)
    }

    pub fn waiting_for_sequence(&self) -> Option<u16> {
        self.volume
            .as_ref()
            .and_then(ActiveVolume::waiting_for_sequence)
    }

    pub fn is_complete(&self) -> bool {
        self.volume.as_ref().is_some_and(ActiveVolume::complete)
    }

    pub fn safe_sweep_published(&self) -> bool {
        self.volume
            .as_ref()
            .is_some_and(|volume| volume.safe_sweep_published)
    }

    pub fn mark_safe_sweep_published(&mut self) -> Result<(), ChunkAssemblyError> {
        let volume = self
            .volume
            .as_mut()
            .ok_or(ChunkAssemblyError::NoActiveVolume)?;
        if volume.safe_sweep_published {
            return Err(ChunkAssemblyError::SafeSweepAlreadyPublished);
        }
        volume.safe_sweep_published = true;
        Ok(())
    }

    pub fn assembled_contiguous(&self) -> Result<Vec<u8>, ChunkAssemblyError> {
        let volume = self
            .volume
            .as_ref()
            .ok_or(ChunkAssemblyError::NoActiveVolume)?;
        assemble(volume, volume.contiguous_through())
    }

    pub fn assembled_complete(&self) -> Result<Vec<u8>, ChunkAssemblyError> {
        let volume = self
            .volume
            .as_ref()
            .ok_or(ChunkAssemblyError::NoActiveVolume)?;
        let terminal = volume
            .terminal_sequence
            .filter(|_| volume.complete())
            .ok_or(ChunkAssemblyError::VolumeIncomplete)?;
        assemble(volume, terminal)
    }

    pub fn latest_contiguous_last_modified_unix_ms(&self) -> Option<i64> {
        let volume = self.volume.as_ref()?;
        volume
            .chunks
            .get(&volume.contiguous_through())
            .map(|chunk| chunk.metadata.last_modified_unix_ms)
    }

    fn ensure_current(&self, generation: u64) -> Result<(), ChunkAssemblyError> {
        if generation != self.generation {
            return Err(ChunkAssemblyError::StaleGeneration {
                actual: generation,
                expected: self.generation,
            });
        }
        if !self.active {
            return Err(ChunkAssemblyError::GenerationCancelled(generation));
        }
        Ok(())
    }
}

fn assemble(volume: &ActiveVolume, through: u16) -> Result<Vec<u8>, ChunkAssemblyError> {
    if through == 0 {
        return Err(ChunkAssemblyError::StartChunkRequired);
    }
    let capacity = (1..=through).try_fold(0usize, |total, sequence| {
        volume
            .chunks
            .get(&sequence)
            .and_then(|chunk| total.checked_add(chunk.bytes.len()))
            .filter(|value| *value <= MAX_REALTIME_VOLUME_BYTES)
            .ok_or(ChunkAssemblyError::VolumeIncomplete)
    })?;
    let mut bytes = Vec::with_capacity(capacity);
    for sequence in 1..=through {
        let chunk = volume
            .chunks
            .get(&sequence)
            .ok_or(ChunkAssemblyError::VolumeIncomplete)?;
        bytes.extend_from_slice(&chunk.bytes);
    }
    Ok(bytes)
}

fn validate_site(site: &str) -> Result<(), ChunkAssemblyError> {
    if site.len() != 4
        || !site
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit())
    {
        return Err(ChunkAssemblyError::InvalidSite(
            "site must be exactly four uppercase ASCII letters/digits".into(),
        ));
    }
    Ok(())
}

fn validate_sequence_type(metadata: &ChunkMetadata) -> Result<(), ChunkAssemblyError> {
    match (metadata.sequence, metadata.kind) {
        (1, ChunkKind::Start) => Ok(()),
        (1, _) => Err(ChunkAssemblyError::InvalidSequence(
            "sequence 001 must be a start chunk".into(),
        )),
        (_, ChunkKind::Start) => Err(ChunkAssemblyError::InvalidSequence(
            "a start chunk must be sequence 001".into(),
        )),
        _ => Ok(()),
    }
}

fn validate_payload(kind: ChunkKind, bytes: &[u8]) -> Result<(), ChunkAssemblyError> {
    let valid = match kind {
        ChunkKind::Start => bytes.starts_with(b"AR2"),
        ChunkKind::Intermediate | ChunkKind::End => {
            bytes.len() >= 6 && bytes.get(4..6) == Some(b"BZ".as_slice())
        }
    };
    valid
        .then_some(())
        .ok_or(ChunkAssemblyError::ChunkPayloadMismatch)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bytes(kind: ChunkKind, marker: u8) -> Vec<u8> {
        match kind {
            ChunkKind::Start => vec![b'A', b'R', b'2', marker],
            ChunkKind::Intermediate | ChunkKind::End => vec![0, 0, 0, marker, b'B', b'Z'],
        }
    }

    fn metadata(volume: u16, started: &str, sequence: u16, kind: ChunkKind) -> ChunkMetadata {
        let suffix = match kind {
            ChunkKind::Start => "S",
            ChunkKind::Intermediate => "I",
            ChunkKind::End => "E",
        };
        let key = format!("KTLX/{volume}/{started}-{sequence:03}-{suffix}");
        let payload = bytes(kind, sequence as u8);
        ChunkMetadata::from_s3_object(
            "KTLX",
            &key,
            1_800_000_000_000 + i64::from(sequence),
            payload.len(),
            None,
        )
        .unwrap()
    }

    fn ingest(
        assembler: &mut ChunkAssembler,
        volume: u16,
        started: &str,
        sequence: u16,
        kind: ChunkKind,
    ) -> Result<ChunkIngestOutcome, ChunkAssemblyError> {
        assembler.ingest(
            1,
            metadata(volume, started, sequence, kind),
            bytes(kind, sequence as u8),
        )
    }

    #[test]
    fn parses_real_bucket_key_shape() {
        let parsed = ChunkMetadata::from_s3_object(
            "KTLX",
            "KTLX/337/20260801-041327-064-E",
            1_775_188_654_000,
            123,
            Some("etag".into()),
        )
        .unwrap();
        assert_eq!(parsed.volume_index, 337);
        assert_eq!(parsed.sequence, 64);
        assert_eq!(parsed.kind, ChunkKind::End);
        assert_eq!(parsed.volume_started_at_unix_ms, 1_785_557_607_000);
    }

    #[test]
    fn contiguous_start_intermediate_end_completes_atomically() {
        let mut assembler = ChunkAssembler::new(1, "KTLX").unwrap();
        ingest(&mut assembler, 7, "20260801-010203", 1, ChunkKind::Start).unwrap();
        ingest(
            &mut assembler,
            7,
            "20260801-010203",
            2,
            ChunkKind::Intermediate,
        )
        .unwrap();
        let outcome = ingest(&mut assembler, 7, "20260801-010203", 3, ChunkKind::End).unwrap();
        assert!(matches!(
            outcome,
            ChunkIngestOutcome::Accepted {
                contiguous_through: 3,
                waiting_for_sequence: None,
                volume_complete: true,
                ..
            }
        ));
        assert!(assembler.is_complete());
        assert_eq!(assembler.assembled_complete().unwrap().len(), 16);
    }

    #[test]
    fn gap_and_out_of_order_delivery_never_claim_completion() {
        let mut assembler = ChunkAssembler::new(1, "KTLX").unwrap();
        ingest(&mut assembler, 7, "20260801-010203", 1, ChunkKind::Start).unwrap();
        let gap = ingest(&mut assembler, 7, "20260801-010203", 3, ChunkKind::End).unwrap();
        assert!(matches!(
            gap,
            ChunkIngestOutcome::Accepted {
                contiguous_through: 1,
                waiting_for_sequence: Some(2),
                volume_complete: false,
                ..
            }
        ));
        assert!(matches!(
            assembler.assembled_complete(),
            Err(ChunkAssemblyError::VolumeIncomplete)
        ));
        ingest(
            &mut assembler,
            7,
            "20260801-010203",
            2,
            ChunkKind::Intermediate,
        )
        .unwrap();
        assert!(assembler.is_complete());
    }

    #[test]
    fn identical_duplicate_is_a_noop_but_conflicting_duplicate_fails() {
        let mut assembler = ChunkAssembler::new(1, "KTLX").unwrap();
        let meta = metadata(7, "20260801-010203", 1, ChunkKind::Start);
        assembler
            .ingest(1, meta.clone(), bytes(ChunkKind::Start, 1))
            .unwrap();
        assert!(matches!(
            assembler
                .ingest(1, meta.clone(), bytes(ChunkKind::Start, 1))
                .unwrap(),
            ChunkIngestOutcome::Duplicate { sequence: 1, .. }
        ));
        let mut conflict = bytes(ChunkKind::Start, 1);
        conflict.push(99);
        let mut conflict_meta = meta;
        conflict_meta.size_bytes = conflict.len();
        assert!(matches!(
            assembler.ingest(1, conflict_meta, conflict),
            Err(ChunkAssemblyError::ConflictingDuplicate { sequence: 1 })
        ));
    }

    #[test]
    fn byte_identical_duplicate_with_conflicting_kind_fails_in_both_directions() {
        for (first_kind, second_kind) in [
            (ChunkKind::Intermediate, ChunkKind::End),
            (ChunkKind::End, ChunkKind::Intermediate),
        ] {
            let mut assembler = ChunkAssembler::new(1, "KTLX").unwrap();
            ingest(&mut assembler, 7, "20260801-010203", 1, ChunkKind::Start).unwrap();
            let payload = bytes(ChunkKind::Intermediate, 2);
            let first = metadata(7, "20260801-010203", 2, first_kind);
            let mut second = metadata(7, "20260801-010203", 2, second_kind);
            second.size_bytes = payload.len();
            assembler.ingest(1, first, payload.clone()).unwrap();
            assert!(matches!(
                assembler.ingest(1, second, payload.clone()),
                Err(ChunkAssemblyError::ConflictingDuplicate { sequence: 2 })
            ));
        }
    }

    #[test]
    fn newer_start_rolls_over_without_publishing_incomplete_old_volume() {
        let mut assembler = ChunkAssembler::new(1, "KTLX").unwrap();
        ingest(&mut assembler, 7, "20260801-010203", 1, ChunkKind::Start).unwrap();
        let outcome = ingest(&mut assembler, 8, "20260801-010603", 1, ChunkKind::Start).unwrap();
        assert!(matches!(
            outcome,
            ChunkIngestOutcome::Rollover {
                abandoned_incomplete_volume: Some(_),
                ..
            }
        ));
        assert_eq!(assembler.active_volume().unwrap().volume_index, 8);
        assert!(!assembler.is_complete());
    }

    #[test]
    fn late_chunk_is_ignored_after_rollover() {
        let mut assembler = ChunkAssembler::new(1, "KTLX").unwrap();
        ingest(&mut assembler, 7, "20260801-010203", 1, ChunkKind::Start).unwrap();
        ingest(&mut assembler, 8, "20260801-010603", 1, ChunkKind::Start).unwrap();
        let late = ingest(
            &mut assembler,
            7,
            "20260801-010203",
            2,
            ChunkKind::Intermediate,
        )
        .unwrap();
        assert!(matches!(late, ChunkIngestOutcome::Late { .. }));
        assert_eq!(assembler.contiguous_through(), 1);
    }

    #[test]
    fn cancellation_and_stale_generation_cannot_mutate_the_pipeline() {
        let mut assembler = ChunkAssembler::new(2, "KTLX").unwrap();
        let meta = metadata(7, "20260801-010203", 1, ChunkKind::Start);
        assert!(matches!(
            assembler.ingest(1, meta.clone(), bytes(ChunkKind::Start, 1)),
            Err(ChunkAssemblyError::StaleGeneration {
                actual: 1,
                expected: 2
            })
        ));
        assembler.cancel();
        assert!(matches!(
            assembler.ingest(2, meta, bytes(ChunkKind::Start, 1)),
            Err(ChunkAssemblyError::GenerationCancelled(2))
        ));
        assert!(assembler.active_volume().is_none());
    }

    #[test]
    fn end_cannot_be_followed_by_a_later_sequence() {
        let mut assembler = ChunkAssembler::new(1, "KTLX").unwrap();
        ingest(&mut assembler, 7, "20260801-010203", 1, ChunkKind::Start).unwrap();
        ingest(&mut assembler, 7, "20260801-010203", 2, ChunkKind::End).unwrap();
        assert!(matches!(
            ingest(
                &mut assembler,
                7,
                "20260801-010203",
                3,
                ChunkKind::Intermediate
            ),
            Err(ChunkAssemblyError::InvalidSequence(_))
        ));
    }

    #[test]
    fn malformed_payload_is_rejected_before_storage() {
        let mut assembler = ChunkAssembler::new(1, "KTLX").unwrap();
        let mut meta = metadata(7, "20260801-010203", 1, ChunkKind::Start);
        meta.size_bytes = 4;
        assert_eq!(
            assembler.ingest(1, meta, vec![0, 1, 2, 3]),
            Err(ChunkAssemblyError::ChunkPayloadMismatch)
        );
        assert!(assembler.active_volume().is_none());
    }

    #[test]
    fn safe_sweep_publication_is_single_use_per_volume() {
        let mut assembler = ChunkAssembler::new(1, "KTLX").unwrap();
        ingest(&mut assembler, 7, "20260801-010203", 1, ChunkKind::Start).unwrap();
        assembler.mark_safe_sweep_published().unwrap();
        assert!(assembler.safe_sweep_published());
        assert_eq!(
            assembler.mark_safe_sweep_published(),
            Err(ChunkAssemblyError::SafeSweepAlreadyPublished)
        );
    }
}
