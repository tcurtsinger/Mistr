# Glossary

## Radar terms

**Base/radial velocity**: The component of target motion toward or away from the radar. Level II includes mean radial velocity. It is not automatically storm-relative velocity.

**Beam width**: Angular width represented by a radar radial. It may affect gate geometry and missing-radial handling.

**Gate / bin**: One range sample along a radar radial.

**Level II**: Digital radial base data containing measured moments and metadata across multiple elevation sweeps in a volume.

**Level III**: Radar products generated/processed from base data. `N0S` is a Level III storm-relative velocity product used for GustAVO parity.

**Moment**: A measured radar field such as reflectivity, velocity, spectrum width, differential reflectivity, differential phase, or correlation coefficient.

**N0S**: Storm-relative velocity product for the lowest elevation/product variant in the current GustAVO path.

**Radial**: One beam direction containing a sequence of range gates.

**Range folding**: A condition/marker associated with ambiguous radar range or velocity sampling. It must remain distinguishable from ordinary missing data.

**Storm-relative velocity (SRV)**: A derived velocity display with storm motion removed. It must not be confused with raw Level II base velocity.

**Sweep / elevation scan**: Radials collected around the radar at one elevation angle.

**Volume / volume scan**: A sequence of elevation sweeps collected according to a volume coverage pattern.

**VCP (Volume Coverage Pattern)**: The radar's scan strategy, influencing elevation sequence and update timing.

## Data and pipeline terms

**Archive object**: A completed Level II volume stored as one object in the archive bucket.

**Chunk**: One ordered piece of a real-time Level II volume. Multiple chunks must be assembled and validated.

**Fixture**: A pinned source object or chunk sequence with provenance, hash, and expected results used for deterministic tests.

**Generation**: A monotonically increasing identity for one current site/product/request intent. Results from older generations cannot publish.

**Normalized sweep**: Mistr's decoder-independent representation of one product/elevation observation.

**Observation**: One measured radar product at one time, site, and elevation.

**PackedSweep**: Mistr's versioned binary transfer format for a normalized sweep.

**Resident**: An observation whose required GPU resources exist in the current WebGL context epoch.

## Rendering terms

**Context epoch**: Identity assigned to one WebGL context lifetime. All resources from an older epoch are invalid after context loss.

**Custom layer**: A MapLibre layer whose implementation issues its own WebGL draw calls inside the map renderer.

**Hard cut**: Immediate transition from one measured observation to another without an interpolated intermediate image.

**Paint receipt**: A structured event proving that a particular observation/generation was used by a custom-layer render call in a specific context epoch.

**Palette/LUT**: A lookup texture/table mapping raw or scaled radar values to display color and alpha.

**Texture array**: A GPU texture containing multiple same-shaped layers. Mistr may store one observation per layer so playback selects a layer index.

## Product/integration terms

**Adoption gate**: A mandatory evidence-backed criterion that must pass before Mistr can replace any GustAVO path.

**Fallback**: Explicit use of the existing tiled radar when the raw engine is unavailable or unsupported.

**Handoff**: GustAVO's transition between national wide-view radar and selected-site close-view radar around the defined zoom threshold.

**Mistr**: The bounded raw selected-site radar feasibility prototype described by this documentation.

**Shadow mode**: A diagnostic integration mode in which raw data is acquired/compared but the existing tiled radar remains visible.
