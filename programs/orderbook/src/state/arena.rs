use alloc::vec::Vec;

pub type Index = u32;

#[derive(Debug, Clone)]
enum Entry<T> {
    Occupied(T),
    Free(Option<Index>),
}

#[derive(Debug, Clone)]
pub struct Arena<T> {
    storage: Vec<Entry<T>>,
    free_head: Option<Index>,
}

impl<T> Default for Arena<T> {
    fn default() -> Self {
        Self {
            storage: Vec::new(),
            free_head: None,
        }
    }
}

impl<T> Arena<T> {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn alloc(&mut self, value: T) -> Index {
        if let Some(idx) = self.free_head {
            // Reuse a free slot
            let entry = &mut self.storage[idx as usize];
            if let Entry::Free(next_free) = entry {
                self.free_head = *next_free;
                *entry = Entry::Occupied(value);
                idx
            } else {
                // This should never happen if logic is correct
                panic!("Corrupted free list");
            }
        } else {
            // Append new slot
            let idx = self.storage.len() as Index;
            self.storage.push(Entry::Occupied(value));
            idx
        }
    }

    pub fn get(&self, index: Index) -> Option<&T> {
        self.storage
            .get(index as usize)
            .and_then(|entry| match entry {
                Entry::Occupied(val) => Some(val),
                Entry::Free(_) => None,
            })
    }

    pub fn get_mut(&mut self, index: Index) -> Option<&mut T> {
        self.storage
            .get_mut(index as usize)
            .and_then(|entry| match entry {
                Entry::Occupied(val) => Some(val),
                Entry::Free(_) => None,
            })
    }

    pub fn dealloc(&mut self, index: Index) {
        let _ = self.remove(index);
    }

    pub fn remove(&mut self, index: Index) -> Option<T> {
        if index as usize >= self.storage.len() {
            return None;
        }

        let slot = &mut self.storage[index as usize];

        // We can't match on *slot and move out because it's borrowed.
        // We check if it is occupied first.
        let is_occupied = matches!(slot, Entry::Occupied(_));

        if is_occupied {
            let old_entry = core::mem::replace(slot, Entry::Free(self.free_head));

            if let Entry::Occupied(val) = old_entry {
                self.free_head = Some(index);
                Some(val)
            } else {
                unreachable!()
            }
        } else {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_alloc_get() {
        let mut arena = Arena::new();
        let idx1 = arena.alloc(10u32);
        let idx2 = arena.alloc(20u32);

        assert_eq!(*arena.get(idx1).unwrap(), 10);
        assert_eq!(*arena.get(idx2).unwrap(), 20);
        assert_ne!(idx1, idx2);
    }

    #[test]
    fn test_dealloc_reuse() {
        let mut arena = Arena::new();
        let idx1 = arena.alloc(100u32);
        arena.dealloc(idx1);

        assert!(arena.get(idx1).is_none());

        let idx2 = arena.alloc(200u32);
        // We expect reuse of the index or at least a valid allocation
        assert_eq!(idx1, idx2);
        assert_eq!(*arena.get(idx2).unwrap(), 200);
    }

    #[test]
    fn test_get_mut() {
        let mut arena = Arena::new();
        let idx = arena.alloc(50u32);

        if let Some(val) = arena.get_mut(idx) {
            *val = 60;
        }

        assert_eq!(*arena.get(idx).unwrap(), 60);
    }
}
