use crate::{Arena, Index};

#[derive(Debug, Clone)]
pub struct Node<T> {
    pub value: T,
    pub prev: Option<Index>,
    pub next: Option<Index>,
}

impl<T> Node<T> {
    pub fn new(value: T) -> Self {
        Self {
            value,
            prev: None,
            next: None,
        }
    }
}

/// Intrusive doubly-linked list that stores only head/tail indices.
/// Nodes live in `Arena<Node<T>>`.
#[derive(Debug, Clone, Default)]
pub struct List {
    pub head: Option<Index>,
    pub tail: Option<Index>,
}

impl List {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push_back<T>(&mut self, arena: &mut Arena<Node<T>>, value: T) -> Index {
        let mut node = Node::new(value);
        node.prev = self.tail;
        node.next = None;

        let idx = arena.alloc(node);

        match self.tail {
            Some(tail) => {
                // link old tail -> new
                arena.get_mut(tail).expect("tail must exist").next = Some(idx);
            }
            None => {
                // list was empty
                self.head = Some(idx);
            }
        }
        self.tail = Some(idx);
        idx
    }

    pub fn push_front<T>(&mut self, arena: &mut Arena<Node<T>>, value: T) -> Index {
        let mut node = Node::new(value);
        node.prev = None;
        node.next = self.head;

        let idx = arena.alloc(node);

        match self.head {
            Some(head) => {
                arena.get_mut(head).expect("head must exist").prev = Some(idx);
            }
            None => {
                self.tail = Some(idx);
            }
        }
        self.head = Some(idx);
        idx
    }

    pub fn peek_front<'a, T>(&self, arena: &'a Arena<Node<T>>) -> Option<&'a T> {
        self.head.and_then(|i| arena.get(i)).map(|n| &n.value)
    }

    pub fn peek_back<'a, T>(&self, arena: &'a Arena<Node<T>>) -> Option<&'a T> {
        self.tail.and_then(|i| arena.get(i)).map(|n| &n.value)
    }

    pub fn pop_front<T>(&mut self, arena: &mut Arena<Node<T>>) -> Option<T> {
        let head = self.head?;
        let next = arena.get(head)?.next;

        match next {
            Some(n) => {
                arena.get_mut(n).expect("next must exist").prev = None;
                self.head = Some(n);
            }
            None => {
                // single element
                self.head = None;
                self.tail = None;
            }
        }

        arena.remove(head).map(|node| node.value)
    }

    pub fn pop_back<T>(&mut self, arena: &mut Arena<Node<T>>) -> Option<T> {
        let tail = self.tail?;
        let prev = arena.get(tail)?.prev;

        match prev {
            Some(p) => {
                arena.get_mut(p).expect("prev must exist").next = None;
                self.tail = Some(p);
            }
            None => {
                self.head = None;
                self.tail = None;
            }
        }

        arena.remove(tail).map(|node| node.value)
    }

    /// Remove a node by index (must belong to this list).
    pub fn remove<T>(&mut self, arena: &mut Arena<Node<T>>, idx: Index) -> Option<T> {
        let (prev, next) = {
            let node = arena.get(idx)?;
            (node.prev, node.next)
        };

        match prev {
            Some(p) => {
                arena.get_mut(p)?.next = next;
            }
            None => {
                // removing head
                self.head = next;
            }
        }

        match next {
            Some(n) => {
                arena.get_mut(n)?.prev = prev;
            }
            None => {
                // removing tail
                self.tail = prev;
            }
        }

        arena.remove(idx).map(|node| node.value)
    }
}

#[cfg(test)]
mod tests {
    extern crate std;
    use super::*;
    use crate::Arena;

    fn assert_list_invariants<T>(list: &List, arena: &Arena<Node<T>>) {
        use std::collections::HashSet;

        match (list.head, list.tail) {
            (None, None) => return,
            (Some(_), Some(_)) => {}
            _ => panic!(
                "head/tail mismatch: head={:?}, tail={:?}",
                list.head, list.tail
            ),
        }

        // Head.prev == None, Tail.next == None
        let head = list.head.unwrap();
        let tail = list.tail.unwrap();

        let head_node = arena.get(head).expect("head points to missing node");
        assert!(head_node.prev.is_none(), "head.prev must be None");

        let tail_node = arena.get(tail).expect("tail points to missing node");
        assert!(tail_node.next.is_none(), "tail.next must be None");

        // Walk forward, verify prev links and that tail is reachable, no cycles.
        let mut seen = HashSet::new();
        let mut cur = list.head;
        let mut prev = None;
        let mut last = None;

        while let Some(i) = cur {
            assert!(seen.insert(i), "cycle detected at {:?}", i);
            let node = arena.get(i).expect("list points to missing node");

            assert_eq!(node.prev, prev, "broken prev link at {:?}", i);

            prev = Some(i);
            last = Some(i);
            cur = node.next;
        }

        assert_eq!(
            last, list.tail,
            "tail mismatch: walked last={:?}, tail={:?}",
            last, list.tail
        );
    }

    #[test]
    fn list_push_pop_fifo() {
        let mut arena: Arena<Node<i32>> = Arena::new();
        let mut list = List::new();

        list.push_back(&mut arena, 1);
        list.push_back(&mut arena, 2);
        list.push_back(&mut arena, 3);

        assert_eq!(list.peek_front(&arena), Some(&1));
        assert_eq!(list.pop_front(&mut arena), Some(1));
        assert_eq!(list.pop_front(&mut arena), Some(2));
        assert_eq!(list.pop_front(&mut arena), Some(3));
        assert_eq!(list.pop_front(&mut arena), None);
        assert!(list.head.is_none());
    }

    #[test]
    fn list_remove_middle() {
        let mut arena: Arena<Node<i32>> = Arena::new();
        let mut list = List::new();

        let _a = list.push_back(&mut arena, 10);
        let b = list.push_back(&mut arena, 20);
        let _c = list.push_back(&mut arena, 30);

        assert_eq!(list.remove(&mut arena, b), Some(20));
        assert_eq!(list.pop_front(&mut arena), Some(10));
        assert_eq!(list.pop_front(&mut arena), Some(30));
        assert!(list.head.is_none());
    }

    #[test]
    fn list_remove_head_tail() {
        let mut arena: Arena<Node<i32>> = Arena::new();
        let mut list = List::new();

        let a = list.push_back(&mut arena, 1);
        let b = list.push_back(&mut arena, 2);

        assert_eq!(list.remove(&mut arena, a), Some(1));
        assert_eq!(list.peek_front(&arena), Some(&2));
        assert_eq!(list.peek_back(&arena), Some(&2));

        assert_eq!(list.remove(&mut arena, b), Some(2));
        assert!(list.head.is_none());
    }

    #[test]
    fn list_push_front_pop_front_lifo() {
        let mut arena: Arena<Node<i32>> = Arena::new();
        let mut list = List::new();

        list.push_front(&mut arena, 1);
        assert_list_invariants(&list, &arena);

        list.push_front(&mut arena, 2);
        assert_list_invariants(&list, &arena);

        list.push_front(&mut arena, 3);
        assert_list_invariants(&list, &arena);

        assert_eq!(list.pop_front(&mut arena), Some(3));
        assert_list_invariants(&list, &arena);

        assert_eq!(list.pop_front(&mut arena), Some(2));
        assert_list_invariants(&list, &arena);

        assert_eq!(list.pop_front(&mut arena), Some(1));
        assert_list_invariants(&list, &arena);

        assert_eq!(list.pop_front(&mut arena), None);
        assert!(list.head.is_none() && list.tail.is_none());
    }

    #[test]
    fn list_push_back_pop_back_lifo() {
        let mut arena: Arena<Node<i32>> = Arena::new();
        let mut list = List::new();

        list.push_back(&mut arena, 1);
        list.push_back(&mut arena, 2);
        list.push_back(&mut arena, 3);
        assert_list_invariants(&list, &arena);

        assert_eq!(list.pop_back(&mut arena), Some(3));
        assert_list_invariants(&list, &arena);

        assert_eq!(list.pop_back(&mut arena), Some(2));
        assert_list_invariants(&list, &arena);

        assert_eq!(list.pop_back(&mut arena), Some(1));
        assert_list_invariants(&list, &arena);

        assert_eq!(list.pop_back(&mut arena), None);
        assert!(list.head.is_none() && list.tail.is_none());
    }

    #[test]
    fn list_pop_on_empty() {
        let mut arena: Arena<Node<i32>> = Arena::new();
        let mut list = List::new();

        assert_eq!(list.pop_front(&mut arena), None);
        assert_eq!(list.pop_back(&mut arena), None);
        assert_list_invariants(&list, &arena);
    }

    #[test]
    fn list_remove_single_elem() {
        let mut arena: Arena<Node<i32>> = Arena::new();
        let mut list = List::new();

        let idx = list.push_back(&mut arena, 42);
        assert_list_invariants(&list, &arena);

        assert_eq!(list.remove(&mut arena, idx), Some(42));
        assert!(list.head.is_none() && list.tail.is_none());
        assert_list_invariants(&list, &arena);
    }

    #[test]
    fn list_remove_head_then_tail() {
        let mut arena: Arena<Node<i32>> = Arena::new();
        let mut list = List::new();

        let a = list.push_back(&mut arena, 10);
        let _b = list.push_back(&mut arena, 20);
        let c = list.push_back(&mut arena, 30);
        assert_list_invariants(&list, &arena);

        assert_eq!(list.remove(&mut arena, a), Some(10));
        assert_list_invariants(&list, &arena);
        assert_eq!(list.peek_front(&arena), Some(&20));

        assert_eq!(list.remove(&mut arena, c), Some(30));
        assert_list_invariants(&list, &arena);
        assert_eq!(list.peek_front(&arena), Some(&20));
        assert_eq!(list.peek_back(&arena), Some(&20));
    }

    #[test]
    fn list_remove_invalid_index_returns_none_and_keeps_list() {
        let mut arena: Arena<Node<i32>> = Arena::new();
        let mut list = List::new();

        list.push_back(&mut arena, 1);
        list.push_back(&mut arena, 2);
        assert_list_invariants(&list, &arena);

        let invalid_idx = Index::new(999_999);
        assert_eq!(list.remove(&mut arena, invalid_idx), None);
        assert_list_invariants(&list, &arena);

        assert_eq!(list.pop_front(&mut arena), Some(1));
        assert_eq!(list.pop_front(&mut arena), Some(2));
        assert_eq!(list.pop_front(&mut arena), None);
    }

    #[test]
    fn list_random_model_based() {
        use std::collections::VecDeque;

        let mut arena: Arena<Node<i32>> = Arena::new();
        let mut list = List::new();

        let mut model: VecDeque<(Index, i32)> = VecDeque::new();

        let mut seed: u64 = 0x1234_5678_9ABC_DEF0;
        fn next_u32(seed: &mut u64) -> u32 {
            *seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
            (*seed >> 32) as u32
        }

        for step in 0..10_000 {
            let r = next_u32(&mut seed) % 100;

            if model.is_empty() {
                let v = (next_u32(&mut seed) % 1000) as i32;
                if r < 50 {
                    let idx = list.push_back(&mut arena, v);
                    model.push_back((idx, v));
                } else {
                    let idx = list.push_front(&mut arena, v);
                    model.push_front((idx, v));
                }
                assert_list_invariants(&list, &arena);
                continue;
            }

            match r {
                0..=29 => {
                    // push_back
                    let v = (next_u32(&mut seed) % 1000) as i32;
                    let idx = list.push_back(&mut arena, v);
                    model.push_back((idx, v));
                    assert_list_invariants(&list, &arena);
                }
                30..=49 => {
                    // push_front
                    let v = (next_u32(&mut seed) % 1000) as i32;
                    let idx = list.push_front(&mut arena, v);
                    model.push_front((idx, v));
                    assert_list_invariants(&list, &arena);
                }
                50..=64 => {
                    // pop_front
                    let got = list.pop_front(&mut arena);
                    let exp = model.pop_front().map(|(_, v)| v);
                    assert_eq!(got, exp, "mismatch at step {} (pop_front)", step);
                    assert_list_invariants(&list, &arena);
                }
                65..=79 => {
                    // pop_back
                    let got = list.pop_back(&mut arena);
                    let exp = model.pop_back().map(|(_, v)| v);
                    assert_eq!(got, exp, "mismatch at step {} (pop_back)", step);
                    assert_list_invariants(&list, &arena);
                }
                _ => {
                    // remove random existing element
                    let k = (next_u32(&mut seed) as usize) % model.len();
                    let (idx, v) = model.remove(k).unwrap();
                    let got = list.remove(&mut arena, idx);
                    assert_eq!(got, Some(v), "mismatch at step {} (remove)", step);
                    assert_list_invariants(&list, &arena);
                }
            }

            let exp_front = model.front().map(|(_, v)| *v);
            let exp_back = model.back().map(|(_, v)| *v);

            assert_eq!(list.peek_front(&arena).copied(), exp_front);
            assert_eq!(list.peek_back(&arena).copied(), exp_back);
        }
    }
}
