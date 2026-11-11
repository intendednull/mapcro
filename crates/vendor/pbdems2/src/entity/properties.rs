use std::sync::Arc;

use rustc_hash::{FxHashMap, FxHashSet};

use super::entities::resolve_field_path;
use super::field_path::FieldPath;
use super::{Entity, Serializer, SerializerContainer, SerializerField};
use crate::{Error, Result};

/// Immutable, schema-bound selection of properties to materialize.
///
/// Listed classes retain only selected properties and their descendants.
/// Unlisted classes retain all properties; combine this with a class filter to
/// omit other classes. Missing classes or paths select nothing, allowing optional
/// fields across game builds. Pointer presence and dynamic-array lengths are
/// always retained so partial updates can clear stale descendants correctly.
///
/// Compile from the playback's serializers. A different serializer schema is
/// rejected rather than interpreting packed keys against another layout.
/// Unselected values are still consumed and checked by their decoder's skip path.
/// Use `Entity::field_value` or `Entity::try_get` to distinguish omitted values
/// from zero. Create a new session to change or widen the selection.
#[derive(Clone, Debug)]
pub struct PropertyFilter(Arc<Selection>);

#[derive(Debug)]
struct Selection {
    schema: Arc<()>,
    classes: FxHashMap<String, ClassProperties>,
}

#[derive(Debug, Default)]
pub(super) struct ClassProperties {
    serializer: Option<Arc<Serializer>>,
    keys: FxHashSet<u64>,
    subtrees: Vec<Prefix>,
}

#[derive(Debug)]
struct Prefix {
    mask: u64,
    key: u64,
    depth: usize,
}

impl PropertyFilter {
    /// Resolve per-class dotted paths using one serializer schema.
    ///
    /// A composite or array path selects its entire subtree, including future
    /// array elements. A numeric dynamic-array element path selects only that element and its
    /// descendants. Repeated class entries are combined.
    pub fn new<C, P, S>(
        serializers: &SerializerContainer,
        classes: impl IntoIterator<Item = (C, P)>,
    ) -> Self
    where
        C: Into<String>,
        P: IntoIterator<Item = S>,
        S: Into<String>,
    {
        let classes = classes
            .into_iter()
            .map(|(name, paths)| (name.into(), paths.into_iter().map(Into::into).collect()))
            .collect();
        Self::compile(serializers, classes)
    }

    // Keep schema walking out of the public generic constructor. Besides reducing
    // client code size, this leaves the shared field resolver local to the decoder.
    fn compile(serializers: &SerializerContainer, classes: Vec<(String, Vec<String>)>) -> Self {
        let mut selections: FxHashMap<String, ClassProperties> = FxHashMap::default();
        for (name, paths) in classes {
            let serializer = serializers.shared(&name);
            let selected = selections.entry(name).or_default();
            let Some(serializer) = serializer else {
                continue;
            };
            selected.serializer = Some(Arc::clone(&serializer));
            for path in paths {
                let Some(key) = serializer.resolve_field_key(&path) else {
                    continue;
                };
                if !selected.keys.insert(key) {
                    continue;
                }
                let field_path = FieldPath::unpack(key);
                if let Ok(field) = resolve_field_path(&serializer, &field_path)
                    && (field.field_serializer.is_some() || field.is_dynamic_array())
                {
                    let mask = FieldPath::prefix_mask(key);
                    selected.subtrees.push(Prefix {
                        mask,
                        key: key & mask,
                        depth: field_path.last,
                    });
                }
            }
        }
        Self(Arc::new(Selection {
            schema: Arc::clone(serializers.schema_id()),
            classes: selections,
        }))
    }

    pub(crate) fn validate(&self, serializers: &SerializerContainer) -> Result<()> {
        if Arc::ptr_eq(&self.0.schema, serializers.schema_id()) {
            return Ok(());
        }
        Err(Error::Parse { context: "property filter belongs to a different serializer schema; create a new filter and session".into() })
    }

    pub(super) fn get(&self, class: &str) -> Option<&ClassProperties> {
        self.0.classes.get(class)
    }

    pub(super) fn retain_entity(&self, entity: &mut Entity) {
        if let Some(properties) = self.get(&entity.class_name) {
            entity.fields.retain(|&key, _| {
                let path = FieldPath::unpack(key);
                path.try_pack().is_some()
                    && properties.serializer.as_ref().is_some_and(|serializer| {
                        resolve_field_path(serializer, &path)
                            .is_ok_and(|field| properties.retains(key, field))
                    })
            });
        }
    }
}

impl ClassProperties {
    #[inline]
    pub(super) fn retains(&self, key: u64, field: &SerializerField) -> bool {
        self.keys.contains(&key)
            || field.metadata.is_pointer()
            || field.is_dynamic_array()
            || self.subtrees.iter().any(|prefix| {
                key & prefix.mask == prefix.key && (key >> 61) as usize >= prefix.depth
            })
    }
}
