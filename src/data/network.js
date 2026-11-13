// ═══════════════════════════════════════════════════════════
//  data/network.js — status-driven Namma Metro network definition
//  Pure data + pure functions. Imports nothing.
//
//  Each line lists its FULL planned station order and divides it into
//  SECTIONS. A section carries its operational status, an optional
//  openFrom instant, and provenance. Only edges inside an *active*
//  section exist in the routing graph, so opening a section later is a
//  data change here — never a routing rewrite.
//
//  Provenance honesty: `verification` is 'secondary' where the facts were
//  cross-checked against published secondary sources only (the BMRCL
//  site was reachable but exposed no machine-readable station/status
//  data). Nothing here is marked 'official' until checked against BMRCL.
//  Check dates: see `verifiedOn`.
// ═══════════════════════════════════════════════════════════

export const SectionStatus = Object.freeze({
  OPEN: 'open',
  UNDER_CONSTRUCTION: 'under_construction',
  PLANNED: 'planned',
});

const WIKI_LIST = 'https://en.wikipedia.org/wiki/List_of_Namma_Metro_stations';
const WIKI_PINK = 'https://en.wikipedia.org/wiki/Pink_Line_(Namma_Metro)';
const CHECKED = '2026-11-13';

export const NETWORK = {
  Purple: {
    color: '#9b72f5',
    stations: ["Whitefield","Hopefarm","Kadugodi Tree Park","Pattandur Agrahara","Sri Sathya Sai","Nallurhalli","Kundalahalli","Seetharamapalya","Hoodi","Garudacharpalya","Singayyanapalya","Krishnarajapura","Benniganahalli","Baiyappanahalli","Swami Vivekananda","Indiranagar","Halasuru","Trinity","MG Road","Cubbon Park","Vidhana Soudha","Visvesvaraya","Majestic","City Railway Stn","Magadi Road","Hosahalli","Vijayanagar","Attiguppe","Deepanjali Nagar","Mysuru Road","Nayandahalli","RR Nagar","Jnanabharathi","Pattanagere","Kengeri Bus Stn","Kengeri","Challaghatta"],
    sections: [
      { from: 'Whitefield', to: 'Challaghatta', status: 'open', openFrom: null, construction: 'mixed',
        source: WIKI_LIST, verifiedOn: CHECKED, verification: 'secondary' },
    ],
  },
  Green: {
    color: '#34d399',
    // Corrected 2026-11-13 vs published list: Sampige Road sits after Srirampura (before Majestic),
    // Banashankari precedes JP Nagar, and Vajarahalli sits between Doddakallasandra and Thalaghattapura.
    stations: ["Madavara","Chikkabidarakallu","Manjunathanagara","Nagasandra","Dasarahalli","Jalahalli","Peenya Industry","Peenya","Goraguntepalya","Yeshwanthpur","Sandal Soap","Mahalakshmi","Rajajinagar","Kuvempu Road","Srirampura","Sampige Road","Majestic","Chickpete","KR Market","National College","Lalbagh","South End Circle","Jayanagar","RV Road","Banashankari","JP Nagar","Yelachenahalli","Konanakunte Cross","Doddakallasandra","Vajarahalli","Thalaghattapura","Silk Institute"],
    sections: [
      { from: 'Madavara', to: 'Silk Institute', status: 'open', openFrom: null, construction: 'mixed',
        source: WIKI_LIST, verifiedOn: CHECKED, verification: 'secondary' },
    ],
  },
  Yellow: {
    color: '#fbbf24',
    stations: ["RV Road","Ragigudda","Jayadeva Hospital","BTM Layout","Central Silk Board","Bommanahalli","Hongasandra","Kudlu Gate","Singasandra","Hosa Road","Beratena Agrahara","Electronic City","Konappana Agrahara","Huskur Road","Biocon Hebbagodi","Bommasandra"],
    sections: [
      { from: 'RV Road', to: 'Bommasandra', status: 'open', openFrom: null, construction: 'elevated',
        source: WIKI_LIST, verifiedOn: CHECKED, verification: 'secondary',
        note: 'Opened to the public August 2025.' },
    ],
  },
  Pink: {
    color: '#ec4899',
    // Station order Kalena Agrahara → Nagawara (18). Sections follow the elevated/underground split.
    // "Tavarekere" is the name used by news reports for the 6th station; the Wikipedia list shows
    // "S.G. Palya (Suddagunte Palya)". Treated as one station with an alias until BMRCL confirms.
    stations: ["Kalena Agrahara","Hulimavu","Bilekahalli IIMB","JP Nagar 4th Phase","Jayadeva Hospital","Tavarekere","Dairy Circle","Lakkasandra","Langford Town","National Military School","MG Road","Shivajinagar","Cantonment","Pottery Town","Tannery Road","Venkateshpura","Kadugundanahalli","Nagawara"],
    sections: [
      { from: 'Kalena Agrahara', to: 'Tavarekere', status: 'open',
        // PROJECT REQUIREMENT: Phase 1 (Kalena Agrahara → Tavarekere) is operational as of 13 Nov 2026.
        // Reports: CMRS clearance 28 Oct; inauguration 13 Nov; regular passenger service from 06:00 on 14 Nov
        // (one source says 15 Nov). This single value controls activation — change it if BMRCL states otherwise.
        openFrom: '2026-11-13T00:00:00+05:30', construction: 'elevated',
        source: WIKI_PINK, verifiedOn: CHECKED, verification: 'secondary',
        note: 'Operational per project requirement from 13 Nov 2026; reports say regular public service began 14 Nov 06:00 IST (one source: 15 Nov). Not yet confirmed against BMRCL.' },
      { from: 'Tavarekere', to: 'Nagawara', status: 'under_construction', openFrom: null, construction: 'underground',
        expectedOpen: 'Mar–May 2027 (estimates vary)',
        source: WIKI_PINK, verifiedOn: CHECKED, verification: 'secondary' },
    ],
  },
};

export const LINE_NAMES = Object.freeze(Object.keys(NETWORK));

const toMs = (t) => (typeof t === 'number' ? t : Date.parse(t));

export function isSectionActive(section, now = Date.now()) {
  if (section.status !== SectionStatus.OPEN) return false;
  return section.openFrom == null || toMs(now) >= toMs(section.openFrom);
}

// Edges [a,b] of one line whose containing section is active at `now`.
// An edge belongs to the section whose [from..to] index range contains both ends.
export function activeEdges(lineName, now = Date.now()) {
  const line = NETWORK[lineName];
  if (!line) return [];
  const idx = new Map(line.stations.map((s, i) => [s, i]));
  const edges = [];
  for (const sec of line.sections) {
    if (!isSectionActive(sec, now)) continue;
    const lo = idx.get(sec.from), hi = idx.get(sec.to);
    for (let i = lo; i < hi; i++) edges.push([line.stations[i], line.stations[i + 1]]);
  }
  return edges;
}

// Ordered stations of a line that currently have at least one active edge, split into
// contiguous chains (a line with a closed gap yields several chains).
export function activeChains(lineName, now = Date.now()) {
  const chains = [];
  for (const [a, b] of activeEdges(lineName, now)) {
    const last = chains[chains.length - 1];
    if (last && last[last.length - 1] === a) last.push(b);
    else chains.push([a, b]);
  }
  return chains;
}

export function activeSequence(lineName, now = Date.now()) {
  return activeChains(lineName, now).flat().filter((s, i, arr) => arr.indexOf(s) === i);
}

export function activeStationSet(now = Date.now()) {
  const set = new Set();
  for (const name of LINE_NAMES) for (const s of activeSequence(name, now)) set.add(s);
  return set;
}

export const isStationActive = (station, now = Date.now()) => activeStationSet(now).has(station);

// Number of distinct active lines serving a station at `now`.
export function activeLinesAt(station, now = Date.now()) {
  return LINE_NAMES.filter(l => activeSequence(l, now).includes(station));
}
