//! Short-span spectral landmark retrieval over the complete Set. A fingerprint
//! describes two local peaks and their time separation, not coarse band signs.
//! Hits vote for a recording position and time scale; spectra still verify the
//! finalists. This is bounded speed/linked-pitch search, not arbitrary pitch invariance.
use super::*;
use std::{
    cmp::Reverse,
    collections::BinaryHeap,
    io::{Read, Write},
};

const MAGIC: &[u8; 8] = b"KDJLVI06";
const HASHES: usize = 1 << 20;
const MAX_TARGETS: usize = 65_536;
// Resident Set postings are not the per-recording feature cache or query work
// area. Dense landmarks need their own bounded budget (about 40 MiB for the
// user's half-hour Set); keeping the old 32 MiB cache cap aborts preprocessing.
const INDEX_MEMORY_BUDGET: usize = 128 * 1024 * 1024;
const MAX_POSTINGS: usize = (INDEX_MEMORY_BUDGET - (HASHES + 1) * 4 - MAX_TARGETS * 4) / 8;
const MAX_VOTES: usize =
    FEATURE_MEMORY_BUDGET / (std::mem::size_of::<Vote>() + std::mem::size_of::<usize>());
const RATES: usize = 19;

#[derive(Clone, Copy)]
struct Landmark {
    frame: usize,
    first: u16,
    second: u16,
    distance: usize,
}
fn landmarks(features: &LiveFeatures) -> impl Iterator<Item = Landmark> + '_ {
    features
        .peaks
        .iter()
        .enumerate()
        .flat_map(move |(frame, peaks)| {
            peaks
                .iter()
                .copied()
                .filter(|&p| p != 0)
                .flat_map(move |first| {
                    // Keep evidence across three short temporal neighborhoods. Each pair
                    // becomes usable when its second peak arrives; no full-window wait.
                    [(6, 14), (14, 22), (22, 31)]
                        .into_iter()
                        .flat_map(move |(lo, hi)| {
                            (frame + lo..(frame + hi).min(features.peaks.len()))
                                .flat_map(move |end| {
                                    features.peaks[end].iter().copied().filter(|&p| p != 0).map(
                                        move |second| Landmark {
                                            frame,
                                            first,
                                            second,
                                            distance: end - frame,
                                        },
                                    )
                                })
                                .take(4)
                        })
                })
        })
}
fn fingerprint(first: i32, second: i32, distance: i32) -> Option<usize> {
    if !(1..=255).contains(&first) || !(1..=255).contains(&second) || !(1..=15).contains(&distance)
    {
        return None;
    }
    Some(((first as usize) << 12) | ((second as usize) << 4) | distance as usize)
}
#[derive(Clone, Copy, Debug)]
pub struct LiveSeed {
    pub target: usize,
    pub offset_seconds: f64,
    pub rate: f64,
    pub retrieval_score: f64,
}
#[derive(Clone, Copy)]
struct Posting(u64);
impl Posting {
    fn new(hash: usize, target: usize, frame: usize) -> Self {
        Self(((hash as u64) << 32) | ((target as u64) << 16) | frame as u64)
    }
    fn hash(self) -> usize {
        (self.0 >> 32) as usize
    }
    fn target(self) -> usize {
        ((self.0 >> 16) & 0xffff) as usize
    }
    fn frame(self) -> usize {
        (self.0 & 0xffff) as usize
    }
}
#[derive(Clone, Default)]
struct Vote {
    anchors: u128,
    bands: u16,
    weight: f32,
    last_pair: u32,
}
#[derive(Default)]
pub struct LiveIndex {
    lengths: Vec<u32>,
    postings: Vec<Posting>,
    offsets: Vec<u32>,
    // Query scratch is separate from the resident index budget. Reuse pages,
    // clearing only touched cells rather than allocating/zeroing every query.
    votes: Vec<Vote>,
    touched: Vec<usize>,
}
impl LiveIndex {
    pub fn add(&mut self, target: usize, features: &LiveFeatures) -> Result<()> {
        anyhow::ensure!(
            target == self.lengths.len() && target < MAX_TARGETS,
            "Set 地标素材顺序无效"
        );
        anyhow::ensure!(
            !features.spectra.is_empty()
                && features.spectra.len() <= 65_536
                && features.peaks.len() == features.spectra.len(),
            "Set 地标素材块长度无效"
        );
        let additional = landmarks(features).count();
        let needed = self
            .postings
            .len()
            .checked_add(additional)
            .ok_or_else(|| anyhow::anyhow!("Set 地标数量溢出"))?;
        anyhow::ensure!(
            needed <= MAX_POSTINGS,
            "Set 地标索引需要 {:.1} MiB，超过独立索引预算 {} MiB（{} 条地标）；素材未被删减",
            (needed * 8 + (HASHES + 1) * 4 + (self.lengths.len() + 1) * 4) as f64 / 1_048_576.,
            INDEX_MEMORY_BUDGET / 1_048_576,
            needed
        );
        // Reserve once per block, before changing the index. Allocation failure
        // is reported as an error, never as a partial or silently pruned index.
        self.postings
            .try_reserve_exact(additional)
            .map_err(|e| anyhow::anyhow!("无法分配 Set 地标索引内存：{e}"))?;
        self.lengths
            .try_reserve(1)
            .map_err(|e| anyhow::anyhow!("无法分配 Set 素材目录：{e}"))?;
        self.lengths.push(features.spectra.len() as u32);
        self.offsets.clear();
        for pair in landmarks(features) {
            let hash = fingerprint(
                pair.first as i32,
                pair.second as i32,
                (pair.distance as f64 / 2.).round() as i32,
            )
            .unwrap();
            self.postings.push(Posting::new(hash, target, pair.frame));
        }
        Ok(())
    }
    pub fn landmark_count(&self) -> usize {
        self.postings.len()
    }
    /// Allocated storage, including the directory required after warming.
    pub fn memory_bytes(&self) -> usize {
        self.postings.capacity() * 8
            + self.lengths.capacity() * 4
            + self.offsets.capacity().max(HASHES + 1) * 4
    }
    pub fn targets(&self) -> Vec<usize> {
        (0..self.lengths.len()).collect()
    }
    pub fn warm(&mut self, canceled: &dyn Fn() -> bool) -> Result<()> {
        if canceled() {
            bail!("匹配已取消")
        }
        if self.offsets.len() == HASHES + 1 {
            return Ok(());
        }
        self.offsets
            .try_reserve_exact(HASHES + 1 - self.offsets.len())
            .map_err(|e| anyhow::anyhow!("无法分配地标查表目录：{e}"))?;
        self.postings.sort_unstable_by_key(|p| p.0);
        self.offsets.resize(HASHES + 1, 0);
        self.offsets.fill(0);
        for p in &self.postings {
            self.offsets[p.hash() + 1] += 1;
        }
        for i in 1..self.offsets.len() {
            self.offsets[i] += self.offsets[i - 1];
        }
        if canceled() {
            bail!("匹配已取消")
        }
        Ok(())
    }
    pub fn search_slice(
        &mut self,
        query: &LiveFeatures,
        canceled: &dyn Fn() -> bool,
    ) -> Result<Vec<LiveSeed>> {
        let rates: [f64; RATES] = std::array::from_fn(|r| 0.80 + r as f64 * 0.025);
        self.search_rates(query, &rates, canceled)
    }
    /// Search every target at a known tempo first. Callers must widen the tempo
    /// range if verification cannot uniquely establish the recording position.
    pub fn search_slice_at_rate(
        &mut self,
        query: &LiveFeatures,
        rate: f64,
        canceled: &dyn Fn() -> bool,
    ) -> Result<Vec<LiveSeed>> {
        anyhow::ensure!((0.80..=1.25).contains(&rate), "实时查询速度无效");
        self.search_rates(query, &[rate], canceled)
    }
    fn search_rates(
        &mut self,
        query: &LiveFeatures,
        rates: &[f64],
        canceled: &dyn Fn() -> bool,
    ) -> Result<Vec<LiveSeed>> {
        anyhow::ensure!(
            (350. ..=3000.).contains(&query.duration_ms()),
            "地标查询窗口必须为 0.35–3 秒"
        );
        self.warm(canceled)?;
        let pairs: Vec<_> = landmarks(query).collect();
        let available = pairs
            .iter()
            .fold(0u128, |mask, p| mask | (1u128 << (p.frame / 3)));
        if available.count_ones() < 4 {
            return Ok(vec![]);
        }
        let hypotheses: Vec<_> = rates
            .iter()
            .map(|&rate| (rate, (rate.log2() * 48.).round() as i32))
            .collect();
        let mut ranked = BinaryHeap::new();
        let mut first = 0;
        while first < self.lengths.len() {
            // Dense, bounded pages avoid a hash allocation per hit. Process all
            // pages rather than dropping candidates when a vote budget fills.
            let mut bases = vec![0usize];
            let mut last = first;
            while last < self.lengths.len() {
                let end = bases.last().unwrap() + (self.lengths[last] as usize).div_ceil(4);
                if end * rates.len() > MAX_VOTES {
                    break;
                }
                bases.push(end);
                last += 1;
            }
            anyhow::ensure!(last > first, "地标投票区块超过预算");
            let width = *bases.last().unwrap();
            for &cell in &self.touched {
                self.votes[cell] = Vote::default();
            }
            self.touched.clear();
            if self.votes.len() < width * rates.len() {
                self.votes.resize(width * rates.len(), Vote::default());
            }
            for (pair_index, pair) in pairs.iter().enumerate() {
                if canceled() {
                    bail!("匹配已取消")
                }
                let anchor = 1u128 << (pair.frame / 3);
                for (r, &(rate, linked_pitch)) in hypotheses.iter().enumerate() {
                    let distance = (pair.distance as f64 * rate / 2.).round() as i32;
                    for pitch in
                        [0, linked_pitch]
                            .into_iter()
                            .take(if linked_pitch == 0 { 1 } else { 2 })
                    {
                        for df in -1..=1 {
                            for ds in -1..=1 {
                                for dt in -1..=1 {
                                    let Some(hash) = fingerprint(
                                        pair.first as i32 - pitch + df,
                                        pair.second as i32 - pitch + ds,
                                        distance + dt,
                                    ) else {
                                        continue;
                                    };
                                    let start = self.offsets[hash] as usize;
                                    let end = self.offsets[hash + 1] as usize;
                                    // Common tonal patterns are poor identity evidence. Do not
                                    // let them flood the vote table or dominate a short query.
                                    if end - start > 512 || start == end {
                                        continue;
                                    }
                                    let weight = (1.
                                        + self.postings.len() as f32 / (end - start) as f32)
                                        .ln();
                                    let bucket = &self.postings[start..end];
                                    let lo = bucket.partition_point(|p| p.target() < first);
                                    let hi = bucket.partition_point(|p| p.target() < last);
                                    for posting in &bucket[lo..hi] {
                                        let offset =
                                            posting.frame() as f64 - pair.frame as f64 * rate;
                                        let bin = (offset / 4.).round() as i32;
                                        for bin in bin - 1..=bin + 1 {
                                            if bin < 0
                                                || bin as f64 * 4.
                                                    + (query.spectra.len() - 1) as f64 * rate
                                                    >= self.lengths[posting.target()] as f64 - 1.
                                            {
                                                continue;
                                            }
                                            let cell = r * width
                                                + bases[posting.target() - first]
                                                + bin as usize;
                                            let vote = &mut self.votes[cell];
                                            if vote.anchors == 0 {
                                                self.touched.push(cell);
                                            }
                                            // Count each query pair once per cell, not each
                                            // fuzzy hash/posting hit. Temporal occupancy alone
                                            // saturates on unrelated music in a large Set.
                                            let pair_id = pair_index as u32 + 1;
                                            if vote.last_pair != pair_id {
                                                vote.weight += weight;
                                                vote.last_pair = pair_id;
                                            }
                                            vote.anchors |= anchor;
                                            vote.bands |= 1 << (pair.first / 32);
                                            vote.bands |= 1 << (pair.second / 32);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            for &cell in &self.touched {
                let v = &self.votes[cell];
                let span = 127 - v.anchors.leading_zeros() - v.anchors.trailing_zeros();
                let support = v.anchors.count_ones();
                if support < 4 || span < 6 || v.bands.count_ones() < 2 {
                    continue;
                }
                let pos = cell % width;
                let target = bases.partition_point(|&b| b <= pos) - 1;
                let key = (((cell / width) as u64) << 48)
                    | (((target + first) as u64) << 32)
                    | (pos - bases[target]) as u64;
                let candidate = Reverse((v.weight.to_bits(), support, key));
                if ranked.len() < 1024 {
                    ranked.push(candidate);
                } else if ranked.peek().is_some_and(|old| candidate.0 > old.0) {
                    ranked.pop();
                    ranked.push(candidate);
                }
            }
            first = last;
        }
        let mut result: Vec<LiveSeed> = Vec::new();
        for Reverse((_, support, key)) in ranked.into_sorted_vec() {
            let seed = LiveSeed {
                target: ((key >> 32) & 0xffff) as usize,
                offset_seconds: (key as u32) as f64 * 0.04,
                rate: rates[(key >> 48) as usize],
                retrieval_score: support as f64 / available.count_ones() as f64,
            };
            if result.iter().any(|s| {
                s.target == seed.target
                    && (s.offset_seconds - seed.offset_seconds).abs() < 0.09
                    && (s.rate - seed.rate).abs() < 0.04
            }) {
                continue;
            }
            result.push(seed);
            if result.len() == 64 {
                break;
            }
        }
        Ok(result)
    }
    pub fn write_to(&self, mut writer: impl Write) -> Result<()> {
        writer.write_all(MAGIC)?;
        writer.write_all(&(self.lengths.len() as u32).to_le_bytes())?;
        writer.write_all(&(self.postings.len() as u32).to_le_bytes())?;
        for length in &self.lengths {
            writer.write_all(&length.to_le_bytes())?;
        }
        for p in &self.postings {
            writer.write_all(&p.0.to_le_bytes())?;
        }
        Ok(())
    }
    pub fn read_from(mut reader: impl Read) -> Result<Self> {
        let mut magic = [0; 8];
        reader.read_exact(&mut magic)?;
        anyhow::ensure!(&magic == MAGIC, "Set 地标索引版本已变化");
        fn number(r: &mut impl Read) -> Result<u32> {
            let mut bytes = [0; 4];
            r.read_exact(&mut bytes)?;
            Ok(u32::from_le_bytes(bytes))
        }
        let targets = number(&mut reader)? as usize;
        let count = number(&mut reader)? as usize;
        anyhow::ensure!(
            targets > 0 && targets <= MAX_TARGETS && count <= MAX_POSTINGS,
            "Set 地标索引长度无效"
        );
        let mut index = Self::default();
        for _ in 0..targets {
            let length = number(&mut reader)?;
            anyhow::ensure!(length > 0 && length <= 65_536, "Set 地标素材长度无效");
            index.lengths.push(length);
        }
        index
            .postings
            .try_reserve_exact(count)
            .map_err(|e| anyhow::anyhow!("无法读取 Set 地标索引，内存分配失败：{e}"))?;
        for _ in 0..count {
            let mut bytes = [0; 8];
            reader.read_exact(&mut bytes)?;
            let p = Posting(u64::from_le_bytes(bytes));
            anyhow::ensure!(
                p.hash() < HASHES
                    && p.target() < targets
                    && p.frame() < index.lengths[p.target()] as usize,
                "Set 地标索引位置无效"
            );
            index.postings.push(p);
        }
        anyhow::ensure!(reader.read(&mut [0; 1])? == 0, "Set 地标索引存在多余数据");
        Ok(index)
    }
}
