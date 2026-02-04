use core::{fmt, mem};
use sails_rs::Vec;

#[derive(Copy, Clone, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub struct Index(u32);

impl Index {
    pub const fn new(raw: u32) -> Self {
        Self(raw)
    }

    pub fn as_usize(self) -> usize {
        self.0 as usize
    }
}

impl fmt::Debug for Index {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Index({})", self.0)
    }
}

#[derive(Debug)]
pub enum Entry<T> {
    Occupied(T),
    Free(Option<Index>),
}

#[derive(Debug)]
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

    pub fn with_capacity(cap: usize) -> Self {
        Self {
            storage: Vec::with_capacity(cap),
            free_head: None,
        }
    }

    /// Allocate a new value and return its stable Index.
    pub fn alloc(&mut self, value: T) -> Index {
        if let Some(idx) = self.free_head {
            // Reuse a free slot
            let entry = self.storage.get_mut(idx.as_usize()).unwrap_or_else(|| {
                panic!("Corrupted free list: free_head out of bounds: {:?}", idx)
            });

            match entry {
                Entry::Free(next_free) => {
                    self.free_head = *next_free;
                    *entry = Entry::Occupied(value);
                    idx
                }
                Entry::Occupied(_) => {
                    panic!(
                        "Corrupted free list: free_head points to occupied slot: {:?}",
                        idx
                    );
                }
            }
        } else {
            // Append new slot
            let len = self.storage.len();
            let idx_u32: u32 = len
                .try_into()
                .unwrap_or_else(|_| panic!("Arena overflow: too many elements (>{})", u32::MAX));

            let idx = Index(idx_u32);
            self.storage.push(Entry::Occupied(value));
            idx
        }
    }

    pub fn get(&self, index: Index) -> Option<&T> {
        match self.storage.get(index.as_usize())? {
            Entry::Occupied(val) => Some(val),
            Entry::Free(_) => None,
        }
    }

    pub fn get_mut(&mut self, index: Index) -> Option<&mut T> {
        match self.storage.get_mut(index.as_usize())? {
            Entry::Occupied(val) => Some(val),
            Entry::Free(_) => None,
        }
    }

    /// Remove a value from the arena, returning it if the slot was occupied.
    ///
    /// Slot becomes free and is pushed to the free-list head (LIFO).
    pub fn remove(&mut self, index: Index) -> Option<T> {
        let slot = self.storage.get_mut(index.as_usize())?;

        // swap the slot with Free(free_head), moving out the old entry
        let old_entry = mem::replace(slot, Entry::Free(self.free_head));

        match old_entry {
            Entry::Occupied(val) => {
                self.free_head = Some(index);
                Some(val)
            }
            Entry::Free(next) => {
                // restore original free entry (so we don't break free list)
                *slot = Entry::Free(next);
                None
            }
        }
    }

    pub fn dealloc(&mut self, index: Index) {
        let _ = self.remove(index);
    }
}

#[cfg(test)]
mod tests {
    extern crate std;
    use super::*;

    fn assert_arena_invariants<T>(a: &Arena<T>) {
        let mut seen: Vec<Index> = Vec::new();
        let mut cur = a.free_head;

        while let Some(i) = cur {
            if seen.contains(&i) {
                panic!("cycle/duplicate in free list at {:?}", i);
            }
            seen.push(i);

            let entry = a
                .storage
                .get(i.as_usize())
                .unwrap_or_else(|| panic!("free_head points out of bounds: {:?}", i));

            match entry {
                Entry::Free(next) => cur = *next,
                Entry::Occupied(_) => panic!("free list points to occupied slot: {:?}", i),
            }
        }

        for (idx, entry) in a.storage.iter().enumerate() {
            if matches!(entry, Entry::Free(_)) {
                let i = Index::new(idx as u32);
                assert!(
                    seen.contains(&i),
                    "Free slot not reachable from free_head: {:?}",
                    i
                );
            }
        }
    }

    #[test]
    fn arena_reuses_slots() {
        let mut a = Arena::new();
        let i0 = a.alloc(10);
        let i1 = a.alloc(20);
        let i2 = a.alloc(30);

        assert_eq!(a.get(i1), Some(&20));
        assert_eq!(a.remove(i1), Some(20));
        assert!(a.get(i1).is_none());

        let i3 = a.alloc(40);
        // should reuse the freed slot (LIFO)
        assert_eq!(i3, i1);
        assert_eq!(a.get(i3), Some(&40));

        assert_eq!(a.get(i0), Some(&10));
        assert_eq!(a.get(i2), Some(&30));
    }

    #[test]
    fn double_remove_returns_none() {
        let mut a = Arena::new();
        let i = a.alloc(1);
        assert_eq!(a.remove(i), Some(1));
        assert_eq!(a.remove(i), None);
    }

    #[test]
    fn get_out_of_bounds_is_none() {
        let mut a: Arena<i32> = Arena::new();
        assert_eq!(a.get(Index::new(0)), None);
        assert_eq!(a.get_mut(Index::new(0)), None);

        let i = a.alloc(1);
        assert_eq!(a.get(Index::new(i.as_usize() as u32 + 1000)), None);
        assert_arena_invariants(&a);
    }

    #[test]
    fn get_mut_allows_mutation() {
        let mut a = Arena::new();
        let i = a.alloc(10);

        *a.get_mut(i).unwrap() = 99;
        assert_eq!(a.get(i), Some(&99));

        assert_arena_invariants(&a);
    }

    #[test]
    fn remove_free_slot_does_not_corrupt_free_list() {
        let mut a = Arena::new();
        let i0 = a.alloc(1);
        let i1 = a.alloc(2);
        assert_eq!(a.remove(i0), Some(1));
        assert_arena_invariants(&a);

        // remove of the same slot
        assert_eq!(a.remove(i0), None);
        assert_arena_invariants(&a);

        // free-list must work
        let i2 = a.alloc(3);
        assert_eq!(i2, i0); // LIFO reuse
        assert_eq!(a.get(i2), Some(&3));
        assert_eq!(a.get(i1), Some(&2));
        assert_arena_invariants(&a);
    }

    #[test]
    fn reuse_is_lifo_stack() {
        let mut a = Arena::new();

        let i0 = a.alloc(10);
        let i1 = a.alloc(20);
        let i2 = a.alloc(30);
        assert_arena_invariants(&a);

        assert_eq!(a.remove(i1), Some(20));
        assert_arena_invariants(&a);

        assert_eq!(a.remove(i2), Some(30));
        assert_arena_invariants(&a);

        // free-list: i2 -> i1
        let j0 = a.alloc(100);
        assert_eq!(j0, i2);
        assert_arena_invariants(&a);

        let j1 = a.alloc(200);
        assert_eq!(j1, i1);
        assert_arena_invariants(&a);

        let j2 = a.alloc(300);
        assert_ne!(j2, i0);
        assert_arena_invariants(&a);
    }

    #[test]
    fn dealloc_is_safe() {
        let mut a = Arena::new();
        let i = a.alloc(1);
        a.dealloc(i);
        assert_arena_invariants(&a);

        a.dealloc(i);
        assert_arena_invariants(&a);
    }

    #[test]
    fn mass_reuse_even_slots() {
        let mut a: Arena<i32> = Arena::new();
        let mut idxs = Vec::new();

        for v in 0..1000 {
            idxs.push(a.alloc(v as i32));
        }
        let len_before = a.storage.len();

        // remove even index -> 500 free slots
        for (k, &i) in idxs.iter().enumerate() {
            if k % 2 == 0 {
                assert_eq!(a.remove(i), Some(k as i32));
            }
        }

        // freed slots
        let freed: std::collections::HashSet<usize> = idxs
            .iter()
            .enumerate()
            .filter_map(|(k, i)| (k % 2 == 0).then_some(i.as_usize()))
            .collect();

        // 500 new alloc must be occupied by freed slots
        let mut used = std::collections::HashSet::new();
        for _ in 0..500 {
            let idx = a.alloc(9999);
            assert!(
                freed.contains(&idx.as_usize()),
                "alloc did not reuse a freed slot: {:?}",
                idx
            );
            assert!(
                used.insert(idx.as_usize()),
                "reused same freed slot twice: {:?}",
                idx
            );
        }

        assert_eq!(a.storage.len(), len_before);
    }
}
