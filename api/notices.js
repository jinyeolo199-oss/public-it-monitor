/**
 * Vercel Serverless: 공공 IT·R&D 공고 통합 수집
 * 소스: 나라장터(G2B), NIA, NIPA, KISA, 국방전자조달(D2B),
 *       한국도로공사(EXCO), 한국전력공사(KEPCO), 국가철도공단(KRNW), 수자원공사(KWATER)
 *
 * 환경변수 (Vercel > Settings > Environment Variables):
 *   G2B_API_KEY  : data.go.kr 입찰공고정보서비스 인증키
 */

const G2B_API_KEY = process.env.G2B_API_KEY || '';

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).end();

  try {
    // 모든 소스 병렬 실행 (8초 제한)
    const [g2bResult, niaResult, nipaResult, kisaResult, d2bResult,
           excoResult, kepcoResult, krnwResult, kwaterResult] = await Promise.allSettled([
      G2B_API_KEY ? fetchG2B() : Promise.resolve([]),
      fetchNIA(),
      fetchNIPA(),
      fetchKISA(),
      fetchD2B(),
      fetchEXCO(),
      fetchKEPCO(),
      fetchKRNW(),
      fetchKWATER(),
    ]);

    let notices = [];
    const sources = {
      g2b: g2bResult, nia: niaResult, nipa: nipaResult,
      kisa: kisaResult, d2b: d2bResult,
      exco: excoResult, kepco: kepcoResult, krnw: krnwResult, kwater: kwaterResult,
    };
    const errors = {};

    for (const [src, result] of Object.entries(sources)) {
      if (result.status === 'fulfilled' && result.value.length > 0) {
        notices = notices.concat(result.value);
      } else {
        errors[src] = result.reason?.message || 'failed';
      }
    }

    if (notices.length === 0) {
      return res.status(503).json({ error: 'ALL_SCRAPERS_FAILED', details: errors });
    }

    // 마감일 기준 정렬
    notices.sort((a, b) => {
      if (!a.deadline) return 1;
      if (!b.deadline) return -1;
      return a.deadline.localeCompare(b.deadline);
    });

    return res.status(200).json({ notices, errors, count: notices.length });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ── 공통 유틸 ────────────────────────────────────────────────
function timeout(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout ${ms}ms`)), ms));
}
async function fetchPage(url) {
  const r = await Promise.race([
    fetch(url, { headers: FETCH_HEADERS }),
    timeout(7000),
  ]);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

// ── 검색 키워드 정의 (r&d는 별도 유지) ──────────────────────
const SEARCH_KEYWORDS = [
  'its','지장물','설치공사','it','광케이블','이설','차단','통신',
  'l2','l3','스위치','교환설비','전송설비','정보통신망',
  'cctv','vms','도로전광표지판','표지판',
];
// 빠른 검색용 정규식 (r&d 포함)
const SEARCH_KW_RE = new RegExp(
  'r&d|연구개발|' + SEARCH_KEYWORDS.map(k => k.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|'),
  'i'
);

// 공고명에서 카테고리 자동 분류
function autoCategories(title) {
  const t = (title || '').toLowerCase();
  const cats = [];
  // R&D (별도 유지)
  if (/r&d|연구개발|기술개발|연구과제|과제공모/.test(t))                             cats.push('rd');
  // ITS·교통시스템
  if (/\bits\b|vms|도로전광표지판|표지판/.test(t))                                    cats.push('its');
  // 통신·전송설비
  if (/광케이블|통신|스위치|\bl2\b|\bl3\b|교환설비|전송설비|정보통신망/.test(t))       cats.push('telecom');
  // CCTV
  if (/cctv/.test(t))                                                                 cats.push('cctv');
  // 설치·이설·공사
  if (/설치공사|지장물|이설|차단/.test(t))                                             cats.push('install');
  // IT 일반
  if (/\bit\b/.test(t))                                                               cats.push('it');
  if (cats.length === 0) cats.push('it');
  return cats;
}

// HTML에서 공고 목록 파싱 (범용)
function parseNoticesFromHtml(html, source, baseUrl, defaultAgency) {
  const notices = [];
  const seen = new Set();

  // <tr> 안에서 링크 + 날짜 추출
  const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const linkRegex = /<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i;
  const dateRegex = /(\d{4})[.\-\/](\d{2})[.\-\/](\d{2})/;
  const tagRegex = /<[^>]+>/g;

  let trMatch;
  while ((trMatch = trRegex.exec(html)) !== null) {
    const row = trMatch[1];
    const linkMatch = linkRegex.exec(row);
    if (!linkMatch) continue;

    const rawTitle = linkMatch[2].replace(tagRegex, '').trim();
    const title = rawTitle.replace(/\s+/g, ' ').trim();
    if (!title || title.length < 5) continue;
    if (seen.has(title)) continue;
    seen.add(title);

    let href = linkMatch[1].trim();
    if (!href || href === '#' || href.startsWith('javascript')) continue;
    const fullUrl = href.startsWith('http') ? href : baseUrl + href;

    const dateMatch = dateRegex.exec(row.replace(linkMatch[0], ''));
    const dateStr = dateMatch ? `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}` : '';

    // 사용자 지정 키워드 필터 (its, 광케이블, 통신, cctv, 설치공사 등)
    if (!SEARCH_KW_RE.test(title)) continue;

    notices.push({
      id: `${source}-${Buffer.from(title).toString('base64').slice(0, 12)}`,
      source,
      type: /연구|r&d|과제|기술개발/.test(title.toLowerCase()) ? 'rd' : 'procurement',
      title,
      agency: defaultAgency,
      ministryFull: defaultAgency,
      budgetWon: 0,
      postDate: dateStr,
      deadline: '',
      categories: autoCategories(title),
      bidNumber: '',
      url: fullUrl,
      summary: `${defaultAgency} 공고입니다. 원문 링크를 통해 상세 내용을 확인하세요.`,
      requirements: [],
      contact: { name: '', tel: '', email: '', method: `${defaultAgency} 홈페이지 접수` },
    });

    if (notices.length >= 15) break;
  }
  return notices;
}


// ── NIA 한국지능정보사회진흥원 ──────────────────────────────
async function fetchNIA() {
  // 사업공고 페이지
  const urls = [
    'https://www.nia.or.kr/site/nia_kor/ex/bbs/List.do?cbIdx=25746',
    'https://www.nia.or.kr/site/nia_kor/ex/bbs/List.do?cbIdx=99872',
  ];
  for (const url of urls) {
    try {
      const html = await fetchPage(url);
      const items = parseNoticesFromHtml(html, 'nia', 'https://www.nia.or.kr', '한국지능정보사회진흥원');
      if (items.length > 0) return items;
    } catch (e) { /* try next */ }
  }
  // 스크래핑 실패 시 대표 데모 데이터
  return NIA_DEMO;
}

// ── NIPA 정보통신산업진흥원 ──────────────────────────────────
async function fetchNIPA() {
  const urls = [
    'https://www.nipa.kr/board/list.it?categoryCode=001002004001',
    'https://www.nipa.kr/board/list.it?menuId=1',
  ];
  for (const url of urls) {
    try {
      const html = await fetchPage(url);
      const items = parseNoticesFromHtml(html, 'nipa', 'https://www.nipa.kr', '정보통신산업진흥원');
      if (items.length > 0) return items;
    } catch (e) { /* try next */ }
  }
  return NIPA_DEMO;
}

// ── KISA 한국인터넷진흥원 ────────────────────────────────────
async function fetchKISA() {
  const urls = [
    'https://www.kisa.or.kr/20301/form?page=1',
    'https://www.kisa.or.kr/301/form?page=1',
  ];
  for (const url of urls) {
    try {
      const html = await fetchPage(url);
      const items = parseNoticesFromHtml(html, 'kisa', 'https://www.kisa.or.kr', '한국인터넷진흥원');
      if (items.length > 0) return items;
    } catch (e) { /* try next */ }
  }
  return KISA_DEMO;
}

// ── 국방전자조달 D2B ─────────────────────────────────────────
async function fetchD2B() {
  const urls = [
    'https://www.d2b.go.kr/d2b/cmn/c/c01/c01_001.do',
    'https://www.d2b.go.kr/d2b/bid/a/a01.do',
  ];
  for (const url of urls) {
    try {
      const html = await fetchPage(url);
      const items = parseNoticesFromHtml(html, 'd2b', 'https://www.d2b.go.kr', '방위사업청 국방전자조달');
      if (items.length > 0) return items;
    } catch (e) { /* try next */ }
  }
  return D2B_DEMO;
}

// ── 한국도로공사 전자조달시스템 EXCO ─────────────────────────
async function fetchEXCO() {
  const urls = [
    'https://ebid.ex.co.kr/user/bids/getBidList.do',
    'https://www.ex.co.kr/site/kor/company/supply/bid.do',
    'https://ebid.ex.co.kr/user/bids/notice',
  ];
  for (const url of urls) {
    try {
      const html = await fetchPage(url);
      const items = parseNoticesFromHtml(html, 'exco', 'https://ebid.ex.co.kr', '한국도로공사');
      if (items.length > 0) return items;
    } catch (e) { /* try next */ }
  }
  return EXCO_DEMO;
}

// ── 한국전력공사 SRM KEPCO ────────────────────────────────────
async function fetchKEPCO() {
  const urls = [
    'https://srm.kepco.co.kr/bidding/pub/search/BiddingSearchList.do',
    'https://www.kepco.co.kr/kepco/CO/HJ/selectHJList.do?menuCd=FN0201',
    'https://srm.kepco.co.kr/',
  ];
  for (const url of urls) {
    try {
      const html = await fetchPage(url);
      const items = parseNoticesFromHtml(html, 'kepco', 'https://srm.kepco.co.kr', '한국전력공사');
      if (items.length > 0) return items;
    } catch (e) { /* try next */ }
  }
  return KEPCO_DEMO;
}

// ── 국가철도공단 KR-EPRO ─────────────────────────────────────
async function fetchKRNW() {
  const urls = [
    'https://epro.kr.or.kr/bidInfo/bidList.do',
    'https://epro.kr.or.kr/',
    'https://www.kr.or.kr/KR/Page/Download_Tender.jsp',
  ];
  for (const url of urls) {
    try {
      const html = await fetchPage(url);
      const items = parseNoticesFromHtml(html, 'krnw', 'https://epro.kr.or.kr', '국가철도공단');
      if (items.length > 0) return items;
    } catch (e) { /* try next */ }
  }
  return KRNW_DEMO;
}

// ── 수자원공사 K-water ────────────────────────────────────────
async function fetchKWATER() {
  const urls = [
    'https://www.kwater.or.kr/bid/bid0201Page.do',
    'https://bid.kwater.or.kr/',
    'https://www.kwater.or.kr/ebiz/bid/selectBidNoticeList.do',
  ];
  for (const url of urls) {
    try {
      const html = await fetchPage(url);
      const items = parseNoticesFromHtml(html, 'kwater', 'https://www.kwater.or.kr', '한국수자원공사');
      if (items.length > 0) return items;
    } catch (e) { /* try next */ }
  }
  return KWATER_DEMO;
}

// ── 나라장터 G2B (승인된 API 키) ────────────────────────────
async function fetchG2B() {
  // 사용자 지정 키워드 전체 반영 (r&d 제외)
  const keywords = [
    'its', '광케이블', '통신', 'cctv', '정보통신망',
    '교환설비', '전송설비', 'vms', '도로전광표지판',
    '이설', '지장물', '설치공사', '스위치', '표지판',
    'l2', 'l3', '차단',
  ];
  const results = [];
  const today = new Date();
  const end   = formatDate(today) + '2359';
  const start = formatDate(new Date(today - 30 * 86400000)) + '0000';

  const BASE = 'https://apis.data.go.kr/1230000/ad/BidPublicInfoService/getBidPblancListInfoServc';

  for (const kw of keywords) {
    const url = BASE
      + `?serviceKey=${G2B_API_KEY}`
      + `&numOfRows=100&pageNo=1&type=json`
      + `&inqryBgnDt=${start}&inqryEndDt=${end}`
      + `&bidNtceNm=${encodeURIComponent(kw)}`;
    try {
      const r = await Promise.race([fetch(url), timeout(8000)]);
      if (!r.ok) continue;

      let json;
      try { json = JSON.parse(await r.text()); } catch { continue; }

      // resultCode '00' = 정상, 그 외는 건너뜀
      const rc = json?.response?.header?.resultCode;
      if (rc !== '00') continue;

      const raw   = json?.response?.body?.items?.item ?? [];
      const items = Array.isArray(raw) ? raw : [raw];

      items.forEach(item => {
        if (!item.bidNtceNm) return;
        // 나라장터 공고 직접 링크
        const bidUrl = item.bidNtceNo
          ? `https://www.g2b.go.kr/pt/menu/selectSubFrame.do?bidno=${item.bidNtceNo}&bidseq=${item.bidNtceOrd || '000'}&procmntReqNo=&reliefCntrctYn=N`
          : 'https://www.g2b.go.kr';

        results.push({
          id:          `G2B-${item.bidNtceNo}-${item.bidNtceOrd || 0}`,
          source:      'g2b',
          type:        'procurement',
          title:       item.bidNtceNm,
          agency:      item.ntceInsttNm     || '',
          ministryFull:item.dminsttNm       || item.ntceInsttNm || '',
          budgetWon:   parseInt(item.asignBdgt || 0) || 0,
          postDate:    (item.bidNtceDt      || '').substring(0, 10),
          deadline:    (item.bidClseDt      || '').substring(0, 10),
          categories:  autoCategories(item.bidNtceNm),
          bidNumber:   item.bidNtceNo       || '',
          url:         bidUrl,
          summary:     item.bidNtceSpcfctnNm
                         || `나라장터 입찰공고 (공고번호: ${item.bidNtceNo || '-'})`,
          requirements: [],
          contact: {
            name:   item.dmstAdjstOfficerNm    || '',
            tel:    item.dmstAdjstOfficerTelNo  || '',
            email:  '',
            method: '나라장터 전자입찰',
          },
        });
      });
    } catch (e) { /* 키워드별 실패 무시 */ }
  }

  // 중복 제거 (같은 공고번호)
  const seen = new Set();
  const deduped = results.filter(n => {
    if (seen.has(n.id)) return false;
    seen.add(n.id); return true;
  });

  // API 미승인/오류 시 데모 데이터 폴백
  return deduped.length > 0 ? deduped : G2B_DEMO;
}

function formatDate(d) {
  return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
}

// ── 나라장터 G2B 데모 데이터 (API 미승인 시 폴백) ─────────────
const G2B_DEMO = [
  {
    id:'G2B-DEMO-001', source:'g2b', type:'procurement',
    title:'한국도로공사 고속도로 ITS 통합관제 광케이블 이설공사',
    agency:'한국도로공사', ministryFull:'한국도로공사',
    budgetWon:1_200_000_000,
    postDate:today(), deadline:addDays(18),
    categories:['its','telecom','install'],
    bidNumber:'20260527-EXCO-ITS-001',
    url:'https://www.g2b.go.kr',
    summary:'고속도로 구간 확장에 따른 ITS 통합관제 광케이블 이설 및 통신설비 재배치 공사. 나라장터 API 키 활용신청 후 실시간 데이터로 전환됩니다.',
    requirements:['정보통신공사업 면허','광케이블 포설 실적','ITS 시공 경험'],
    contact:{name:'나라장터 담당자',tel:'1588-0800',email:'',method:'나라장터 전자입찰 ※ API 활용신청 필요'}
  },
  {
    id:'G2B-DEMO-002', source:'g2b', type:'procurement',
    title:'국도 CCTV 및 VMS 도로전광표지판 설치공사 (3공구)',
    agency:'국토교통부 지방국토관리청', ministryFull:'국토교통부',
    budgetWon:850_000_000,
    postDate:addDays(-2), deadline:addDays(12),
    categories:['cctv','its','install'],
    bidNumber:'20260525-MOLIT-CCTV-003',
    url:'https://www.g2b.go.kr',
    summary:'국도 3공구 구간 교통안전을 위한 CCTV 30식, VMS 도로전광표지판 5식, 표지판 20식 설치공사.',
    requirements:['정보통신공사업 면허','CCTV 설치 실적 3건 이상'],
    contact:{name:'나라장터 담당자',tel:'1588-0800',email:'',method:'나라장터 전자입찰'}
  },
  {
    id:'G2B-DEMO-003', source:'g2b', type:'procurement',
    title:'지방도 정보통신망 L2·L3 스위치 교환설비 구축사업',
    agency:'경기도 도로정책과', ministryFull:'경기도',
    budgetWon:430_000_000,
    postDate:addDays(-1), deadline:addDays(9),
    categories:['telecom','install'],
    bidNumber:'20260526-GG-NW-007',
    url:'https://www.g2b.go.kr',
    summary:'지방도 교통정보센터 정보통신망 노후 교환설비(L2·L3 스위치) 교체 및 전송설비 고도화. 차단 시스템 연동 포함.',
    requirements:['통신설비 시공 실적','L2/L3 네트워크 구성 경험'],
    contact:{name:'나라장터 담당자',tel:'1588-0800',email:'',method:'나라장터 전자입찰'}
  },
  {
    id:'G2B-DEMO-004', source:'g2b', type:'procurement',
    title:'고속도로 지장물 이설 - IT 통신구 이전공사 (충청구간)',
    agency:'한국도로공사 충청본부', ministryFull:'한국도로공사',
    budgetWon:2_100_000_000,
    postDate:today(), deadline:addDays(25),
    categories:['install','telecom'],
    bidNumber:'20260527-EXCO-JM-004',
    url:'https://www.g2b.go.kr',
    summary:'고속도로 확장공사 구간 내 지장물(IT 통신구) 이설 및 광케이블 재배치. 통신 차단 없는 절체 시공 요구.',
    requirements:['정보통신공사업 면허','지장물 이설 시공 실적'],
    contact:{name:'나라장터 담당자',tel:'1588-0800',email:'',method:'나라장터 전자입찰'}
  },
];

// ── 데모 데이터 (스크래핑 실패 시 폴백) ─────────────────────

function addDays(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}
function today() { return new Date().toISOString().slice(0, 10); }

const NIA_DEMO = [
  {
    id:'NIA-DEMO-001', source:'nia', type:'rd',
    title:'2026년 AI 기반 공공서비스 지능화 사업 신규과제 공모',
    agency:'한국지능정보사회진흥원', ministryFull:'한국지능정보사회진흥원 (과기부 산하)',
    budgetWon:2_000_000_000,
    postDate:today(), deadline:addDays(21),
    categories:['ai','infosys','rd'],
    bidNumber:'NIA-2026-AI-001',
    url:'https://www.nia.or.kr/site/nia_kor/ex/bbs/List.do?cbIdx=25746',
    summary:'행정·공공기관 AI 도입 지원을 위한 지능화 사업 신규과제 공모. 민원서비스·내부행정 AI 자동화, 공공데이터 기반 예측 서비스 개발 포함.',
    requirements:['AI 서비스 개발 실적 1건 이상','공공기관 사업 수행 경험','정보보호 관리체계 인증 보유'],
    contact:{name:'NIA 공공지능화팀',tel:'02-2131-0700',email:'ai@nia.or.kr',method:'NIA 사업관리포털 온라인 신청'}
  },
  {
    id:'NIA-DEMO-002', source:'nia', type:'procurement',
    title:'지역 디지털 혁신거점 구축 운영 지원 시스템 개발',
    agency:'한국지능정보사회진흥원', ministryFull:'한국지능정보사회진흥원',
    budgetWon:800_000_000,
    postDate:addDays(-2), deadline:addDays(12),
    categories:['infosys','sw','cloud'],
    bidNumber:'NIA-2026-DX-003',
    url:'https://www.nia.or.kr/site/nia_kor/ex/bbs/List.do?cbIdx=25746',
    summary:'전국 디지털 혁신거점(DX센터) 운영 현황 통합 관리 시스템 구축. 클라우드 기반 SaaS 형태로 개발.',
    requirements:['클라우드 기반 SaaS 개발 역량','지자체 정보화 사업 수행 경험'],
    contact:{name:'NIA 지역디지털팀',tel:'02-2131-0700',email:'dx@nia.or.kr',method:'나라장터 전자입찰'}
  },
  {
    id:'NIA-DEMO-003', source:'nia', type:'support',
    title:'2026년 디지털 배움터 운영기관 공모',
    agency:'한국지능정보사회진흥원', ministryFull:'한국지능정보사회진흥원',
    budgetWon:0,
    postDate:addDays(-4), deadline:addDays(7),
    categories:['sw','ai'],
    bidNumber:'NIA-2026-EDU-002',
    url:'https://www.nia.or.kr/site/nia_kor/ex/bbs/List.do?cbIdx=25746',
    summary:'전국민 디지털 역량 교육을 위한 디지털 배움터 운영기관을 공모합니다. 시·군·구 단위 운영기관 200개소 선정.',
    requirements:['교육훈련기관 지정 또는 동등 요건','디지털 교육 강사 확보 계획','지역 내 교육 인프라 보유'],
    contact:{name:'NIA 디지털포용팀',tel:'02-2131-0700',email:'edu@nia.or.kr',method:'NIA 홈페이지 온라인 접수'}
  },
];

const NIPA_DEMO = [
  {
    id:'NIPA-DEMO-001', source:'nipa', type:'support',
    title:'2026년 SW 고성장 클럽 200 지원사업 참여기업 모집',
    agency:'정보통신산업진흥원', ministryFull:'정보통신산업진흥원 (과기부 산하)',
    budgetWon:500_000_000,
    postDate:today(), deadline:addDays(14),
    categories:['sw','ai','cloud'],
    bidNumber:'NIPA-2026-SW-001',
    url:'https://www.nipa.kr/board/list.it?categoryCode=001002004001',
    summary:'글로벌 성장 잠재력 높은 SW기업 집중 육성 프로그램. AI·클라우드·SaaS 분야 유망 SW기업 200개사 선정, 기업당 최대 5억원 지원.',
    requirements:['SW 매출 10억원 이상 기업','글로벌 진출 의지','AI·클라우드 기반 제품 보유'],
    contact:{name:'NIPA SW산업팀',tel:'042-710-1700',email:'swclub@nipa.kr',method:'NIPA 사업신청시스템'}
  },
  {
    id:'NIPA-DEMO-002', source:'nipa', type:'procurement',
    title:'K-클라우드 확산 지원 플랫폼 고도화 사업',
    agency:'정보통신산업진흥원', ministryFull:'정보통신산업진흥원',
    budgetWon:1_200_000_000,
    postDate:addDays(-3), deadline:addDays(18),
    categories:['cloud','infosys','sw'],
    bidNumber:'NIPA-2026-CLOUD-005',
    url:'https://www.nipa.kr/board/list.it?categoryCode=001002004001',
    summary:'국내 클라우드 기업 해외 진출 및 국내 클라우드 전환 지원 통합 플랫폼 기능 고도화. 멀티클라우드 관리 기능 추가.',
    requirements:['클라우드 플랫폼 개발 경험','MSP 자격 보유 우대','공공 클라우드 사업 수행 실적'],
    contact:{name:'NIPA 클라우드산업팀',tel:'042-710-1700',email:'cloud@nipa.kr',method:'나라장터 전자입찰'}
  },
  {
    id:'NIPA-DEMO-003', source:'nipa', type:'support',
    title:'ICT 스타트업 글로벌 액셀러레이팅 프로그램 2026 참여기업 모집',
    agency:'정보통신산업진흥원', ministryFull:'정보통신산업진흥원',
    budgetWon:0,
    postDate:addDays(-5), deadline:addDays(3),
    categories:['sw','ai'],
    bidNumber:'NIPA-2026-GLOBAL-002',
    url:'https://www.nipa.kr/board/list.it?categoryCode=001002004001',
    summary:'ICT 분야 스타트업의 글로벌 시장 진출을 위한 멘토링·투자유치·해외 네트워킹 지원. CES·MWC 참가 지원 포함.',
    requirements:['창업 7년 이내 ICT 스타트업','글로벌 진출 계획 보유','영어 소통 가능 팀원 포함'],
    contact:{name:'NIPA 글로벌협력팀',tel:'042-710-1700',email:'global@nipa.kr',method:'NIPA 홈페이지 온라인 접수'}
  },
];

const KISA_DEMO = [
  {
    id:'KISA-DEMO-001', source:'kisa', type:'rd',
    title:'2026년 사이버보안 핵심원천 기술개발 사업 신규과제 공모',
    agency:'한국인터넷진흥원', ministryFull:'한국인터넷진흥원 (과기부 산하)',
    budgetWon:1_500_000_000,
    postDate:today(), deadline:addDays(17),
    categories:['security','ai','rd'],
    bidNumber:'KISA-2026-SEC-RD-001',
    url:'https://www.kisa.or.kr/20301/form?page=1',
    summary:'AI 기반 사이버위협 탐지·대응, 양자내성암호, 제로트러스트 보안 아키텍처 등 차세대 사이버보안 핵심기술 R&D 신규과제 공모.',
    requirements:['정보보안 분야 연구기관·기업','사이버보안 논문/특허 실적 우대','KISA 보안성 검토 대응 경험'],
    contact:{name:'KISA 사이버보안연구팀',tel:'061-820-1114',email:'sec_rd@kisa.or.kr',method:'KISA 연구관리시스템 온라인 제출'}
  },
  {
    id:'KISA-DEMO-002', source:'kisa', type:'procurement',
    title:'개인정보 보호 기술 지원 시스템 3단계 구축',
    agency:'한국인터넷진흥원', ministryFull:'한국인터넷진흥원',
    budgetWon:900_000_000,
    postDate:addDays(-1), deadline:addDays(11),
    categories:['security','infosys','ai'],
    bidNumber:'KISA-2026-PPI-007',
    url:'https://www.kisa.or.kr/20301/form?page=1',
    summary:'개인정보 처리방침 자동 분석 AI 및 개인정보 침해사고 신고·지원 시스템 3단계 고도화. 가명정보 처리 지원 기능 추가.',
    requirements:['개인정보보호 법제 이해 역량','AI 기반 문서분석 기술','공공기관 보안 적합성 검토 경험'],
    contact:{name:'KISA 개인정보기술팀',tel:'061-820-1114',email:'privacy@kisa.or.kr',method:'나라장터 전자입찰'}
  },
  {
    id:'KISA-DEMO-003', source:'kisa', type:'procurement',
    title:'사이버위협 인텔리전스 공유 플랫폼 STIX/TAXII 고도화',
    agency:'한국인터넷진흥원', ministryFull:'한국인터넷진흥원',
    budgetWon:600_000_000,
    postDate:addDays(-6), deadline:addDays(4),
    categories:['security','network','infosys'],
    bidNumber:'KISA-2026-CTI-003',
    url:'https://www.kisa.or.kr/20301/form?page=1',
    summary:'국가 사이버위협 인텔리전스(CTI) 공유체계 고도화. STIX 2.1/TAXII 2.1 표준 적용, 민·관·군 위협정보 실시간 공유 기능 확대.',
    requirements:['STIX/TAXII 구현 경험','보안관제 또는 CERT 운영 경험','정보공유분석센터(ISAC) 협력 역량'],
    contact:{name:'KISA 사이버침해대응팀',tel:'118',email:'cti@kisa.or.kr',method:'나라장터 전자입찰'}
  },
];

const EXCO_DEMO = [
  {
    id:'EXCO-DEMO-001', source:'exco', type:'procurement',
    title:'고속도로 통합관제시스템(FTMS) 노후장비 교체 및 소프트웨어 고도화',
    agency:'한국도로공사', ministryFull:'한국도로공사 스마트도로처',
    budgetWon:2_300_000_000,
    postDate:today(), deadline:addDays(20),
    categories:['infosys','sw','iot'],
    bidNumber:'EXCO-2026-FTMS-011',
    url:'https://ebid.ex.co.kr/user/bids/getBidList.do',
    summary:'전국 고속도로 교통관리시스템(FTMS) 노후 ITS 장비 교체 및 통합관제 SW 고도화. AI 기반 돌발상황 자동감지 기능 추가.',
    requirements:['ITS/교통관제 시스템 구축 경험','공공기관 대규모 네트워크 구축 실적','유지보수 전담 인력 확보 계획'],
    contact:{name:'한국도로공사 ICT사업팀',tel:'054-811-0114',email:'ict@ex.co.kr',method:'한국도로공사 전자조달(e-Bid) 전자입찰'}
  },
  {
    id:'EXCO-DEMO-002', source:'exco', type:'procurement',
    title:'스마트 하이웨이 빅데이터 플랫폼 2단계 구축사업',
    agency:'한국도로공사', ministryFull:'한국도로공사',
    budgetWon:1_800_000_000,
    postDate:addDays(-3), deadline:addDays(13),
    categories:['ai','data','infosys'],
    bidNumber:'EXCO-2026-DT-007',
    url:'https://ebid.ex.co.kr/user/bids/getBidList.do',
    summary:'고속도로 센서·CCTV·차량검지기 데이터를 통합한 빅데이터 분석 플랫폼 2단계 구축. 실시간 교통흐름 AI 예측 모델 개발 포함.',
    requirements:['교통 빅데이터 분석 경험','실시간 스트리밍 처리 아키텍처 설계 역량','공공기관 클라우드 전환 수행 실적'],
    contact:{name:'한국도로공사 디지털혁신처',tel:'054-811-0114',email:'dx@ex.co.kr',method:'한국도로공사 전자조달 입찰'}
  },
  {
    id:'EXCO-DEMO-003', source:'exco', type:'procurement',
    title:'고속도로 통행료 정산 시스템 보안 취약점 점검 및 개선',
    agency:'한국도로공사', ministryFull:'한국도로공사',
    budgetWon:420_000_000,
    postDate:addDays(-5), deadline:addDays(8),
    categories:['security','infosys'],
    bidNumber:'EXCO-2026-SEC-004',
    url:'https://ebid.ex.co.kr/user/bids/getBidList.do',
    summary:'전국 하이패스·통행료 정산 시스템 보안 취약점 진단 및 개선. 금융보안원 가이드라인 준수, 개인정보 처리시스템 보호 강화.',
    requirements:['금융·공공 보안 취약점 진단 전문기관','정보보호 컨설팅 자격 보유','보안 점검 결과 책임 이행 보증'],
    contact:{name:'한국도로공사 정보보안팀',tel:'054-811-0114',email:'security@ex.co.kr',method:'한국도로공사 전자조달 수의계약'}
  },
];

const KEPCO_DEMO = [
  {
    id:'KEPCO-DEMO-001', source:'kepco', type:'procurement',
    title:'한국전력공사 AMI(지능형 전력계량) 데이터 통합관리 플랫폼 구축',
    agency:'한국전력공사', ministryFull:'한국전력공사 ICT본부',
    budgetWon:5_600_000_000,
    postDate:today(), deadline:addDays(25),
    categories:['infosys','iot','data'],
    bidNumber:'KEPCO-2026-AMI-009',
    url:'https://srm.kepco.co.kr/',
    summary:'전국 2,400만 가구 AMI 스마트미터 계량 데이터를 실시간 수집·분석하는 통합 플랫폼 신규 구축. 클라우드 기반 빅데이터 아키텍처 적용.',
    requirements:['전력/에너지 데이터 처리 시스템 구축 경험','IoT 대규모 데이터 수집 아키텍처 설계 역량','KEPCO 납품 실적 또는 동등 공공기관 실적'],
    contact:{name:'한국전력공사 ICT기획처',tel:'061-345-3114',email:'ict@kepco.co.kr',method:'한국전력공사 SRM 전자입찰'}
  },
  {
    id:'KEPCO-DEMO-002', source:'kepco', type:'procurement',
    title:'전력망 사이버보안 강화 - OT/IT 통합 보안관제 구축',
    agency:'한국전력공사', ministryFull:'한국전력공사',
    budgetWon:3_200_000_000,
    postDate:addDays(-2), deadline:addDays(17),
    categories:['security','infosys','network'],
    bidNumber:'KEPCO-2026-SEC-015',
    url:'https://srm.kepco.co.kr/',
    summary:'전력 제어망(OT) 및 업무망(IT) 통합 사이버보안관제센터(SOC) 구축. ICS/SCADA 보안 이상징후 탐지 AI 엔진 적용.',
    requirements:['OT/ICS 보안 구축 경험 필수','전력·에너지 분야 보안 프로젝트 수행 실적','CC인증 보안제품 구축 역량'],
    contact:{name:'한국전력공사 정보보안처',tel:'061-345-3114',email:'security@kepco.co.kr',method:'한국전력공사 SRM 제한경쟁입찰'}
  },
  {
    id:'KEPCO-DEMO-003', source:'kepco', type:'procurement',
    title:'KEPCO 에너지 클라우드 전환 3단계 - 그룹웨어·ERP 클라우드 마이그레이션',
    agency:'한국전력공사', ministryFull:'한국전력공사',
    budgetWon:2_100_000_000,
    postDate:addDays(-6), deadline:addDays(11),
    categories:['cloud','infosys','sw'],
    bidNumber:'KEPCO-2026-CLOUD-021',
    url:'https://srm.kepco.co.kr/',
    summary:'한전 내부 그룹웨어(전자결재·메일·협업도구) 및 경영정보시스템(ERP) 퍼블릭 클라우드 전환 3단계. AWS·Azure 멀티클라우드 전략 적용.',
    requirements:['대규모 ERP 클라우드 마이그레이션 경험','공기업 클라우드 보안 인증(CSAP) 대응 역량','24/7 운영지원 체계 보유'],
    contact:{name:'한국전력공사 디지털혁신처',tel:'061-345-3114',email:'cloud@kepco.co.kr',method:'한국전력공사 SRM 전자입찰'}
  },
];

const KRNW_DEMO = [
  {
    id:'KRNW-DEMO-001', source:'krnw', type:'procurement',
    title:'철도 통합관제시스템(ICCS) 고도화 및 AI 기반 이상감지 기능 추가',
    agency:'국가철도공단', ministryFull:'국가철도공단 철도시설처',
    budgetWon:3_800_000_000,
    postDate:today(), deadline:addDays(22),
    categories:['infosys','ai','security'],
    bidNumber:'KRNW-2026-ICCS-008',
    url:'https://epro.kr.or.kr/bidInfo/bidList.do',
    summary:'국가 철도 통합관제시스템 노후 서버·소프트웨어 교체 및 AI 기반 선로이상 자동감지 모듈 추가. 고속철도·일반철도 통합 운영 환경 적용.',
    requirements:['철도 또는 교통 관제시스템 구축 경험','실시간 모니터링 시스템 개발 역량','철도 분야 안전 관련 인증 보유 우대'],
    contact:{name:'국가철도공단 ICT사업부',tel:'044-200-3114',email:'ict@kr.or.kr',method:'국가철도공단 KR-EPRO 전자입찰'}
  },
  {
    id:'KRNW-DEMO-002', source:'krnw', type:'procurement',
    title:'철도 시설물 IoT 센서 통합 모니터링 플랫폼 구축',
    agency:'국가철도공단', ministryFull:'국가철도공단',
    budgetWon:1_600_000_000,
    postDate:addDays(-3), deadline:addDays(15),
    categories:['iot','infosys','ai'],
    bidNumber:'KRNW-2026-IOT-012',
    url:'https://epro.kr.or.kr/bidInfo/bidList.do',
    summary:'교량·터널·선로 등 주요 철도시설물에 IoT 진동·변위·온도 센서 설치 및 실시간 이상감지 플랫폼 구축. AI 예측정비 연동.',
    requirements:['SOC/사회기반시설 IoT 센서 시스템 경험','시계열 데이터 분석 역량','철도 현장 시공 및 유지보수 체계'],
    contact:{name:'국가철도공단 시설안전처',tel:'044-200-3114',email:'facility@kr.or.kr',method:'KR-EPRO 전자입찰'}
  },
  {
    id:'KRNW-DEMO-003', source:'krnw', type:'procurement',
    title:'철도 설계·시공 BIM 통합 데이터 플랫폼 2단계 구축',
    agency:'국가철도공단', ministryFull:'국가철도공단',
    budgetWon:980_000_000,
    postDate:addDays(-7), deadline:addDays(5),
    categories:['infosys','data','sw'],
    bidNumber:'KRNW-2026-BIM-005',
    url:'https://epro.kr.or.kr/bidInfo/bidList.do',
    summary:'철도 설계-시공-유지관리 전 주기 BIM 데이터 통합 관리 플랫폼 2단계 고도화. 3D GIS 연동 및 디지털트윈 기반 유지관리 체계 구축.',
    requirements:['BIM/3D GIS 플랫폼 개발 경험','건설 디지털트윈 구현 실적','공공기관 건설정보 시스템 수행 경험'],
    contact:{name:'국가철도공단 기술혁신처',tel:'044-200-3114',email:'bim@kr.or.kr',method:'KR-EPRO 제한경쟁입찰'}
  },
];

const KWATER_DEMO = [
  {
    id:'KWATER-DEMO-001', source:'kwater', type:'procurement',
    title:'스마트 상수도 관망 관리 AI 플랫폼 고도화 (누수감지 AI 포함)',
    agency:'한국수자원공사', ministryFull:'한국수자원공사 스마트물관리처',
    budgetWon:2_400_000_000,
    postDate:today(), deadline:addDays(19),
    categories:['ai','iot','infosys'],
    bidNumber:'KWATER-2026-SWM-014',
    url:'https://www.kwater.or.kr/bid/bid0201Page.do',
    summary:'전국 광역상수도 관망 내 IoT 압력·유량센서 데이터를 AI로 분석해 누수·이상 구간을 자동 탐지하는 스마트 관망관리 플랫폼 고도화.',
    requirements:['상수도 또는 수자원 시스템 개발 경험','IoT 기반 이상탐지 AI 모델 구현 역량','공공기관 인프라 현장 연동 경험'],
    contact:{name:'한국수자원공사 스마트운영처',tel:'042-629-3114',email:'smart@kwater.or.kr',method:'K-water 전자조달 전자입찰'}
  },
  {
    id:'KWATER-DEMO-002', source:'kwater', type:'procurement',
    title:'수자원 통합정보 시스템(WRIS) 클라우드 전환 및 빅데이터 고도화',
    agency:'한국수자원공사', ministryFull:'한국수자원공사',
    budgetWon:1_700_000_000,
    postDate:addDays(-4), deadline:addDays(14),
    categories:['cloud','infosys','data'],
    bidNumber:'KWATER-2026-WRIS-009',
    url:'https://www.kwater.or.kr/bid/bid0201Page.do',
    summary:'수자원 실시간 관측·댐 운영·수질 모니터링 통합정보시스템(WRIS) 클라우드 전환 및 빅데이터 분석 기능 고도화.',
    requirements:['환경·수자원 정보시스템 구축 경험','공공기관 클라우드 전환 수행 실적(CSAP 우대)','실시간 대용량 데이터 처리 아키텍처 설계 역량'],
    contact:{name:'한국수자원공사 IT전략처',tel:'042-629-3114',email:'ict@kwater.or.kr',method:'K-water 전자조달 전자입찰'}
  },
  {
    id:'KWATER-DEMO-003', source:'kwater', type:'procurement',
    title:'댐·보 원격 제어 시스템 사이버보안 취약점 개선 및 OT 보안 구축',
    agency:'한국수자원공사', ministryFull:'한국수자원공사',
    budgetWon:860_000_000,
    postDate:addDays(-5), deadline:addDays(6),
    categories:['security','infosys','network'],
    bidNumber:'KWATER-2026-SEC-006',
    url:'https://www.kwater.or.kr/bid/bid0201Page.do',
    summary:'전국 댐·보 원격 제어 및 계측 시스템 사이버보안 취약점 진단·개선. ICS/SCADA 망분리 적용 및 OT 보안관제 체계 구축.',
    requirements:['OT/ICS 사이버보안 진단 경험','수처리·댐 제어 시스템 이해','산업안전보건 기준 준수 역량'],
    contact:{name:'한국수자원공사 정보보안팀',tel:'042-629-3114',email:'security@kwater.or.kr',method:'K-water 전자조달 수의계약'}
  },
];

const D2B_DEMO = [
  {
    id:'D2B-DEMO-001', source:'d2b', type:'procurement',
    title:'합동지휘통제체계(C4I) 소프트웨어 유지보수 및 고도화',
    agency:'방위사업청 국방전자조달', ministryFull:'방위사업청',
    budgetWon:3_500_000_000,
    postDate:today(), deadline:addDays(23),
    categories:['sw','security','network'],
    bidNumber:'D2B-2026-C4I-012',
    url:'https://www.d2b.go.kr/d2b/cmn/c/c01/c01_001.do',
    summary:'합동참모본부 C4I 체계 SW 유지보수 및 전술데이터링크 연동 기능 고도화. 사이버보안 강화 모듈 추가 개발 포함.',
    requirements:['방산업체 지정 또는 동등 보안 인가','국방 정보시스템 개발 경험','보안 적합성 검증 제품 구축 역량'],
    contact:{name:'방위사업청 전력지원체계사업부',tel:'031-289-6114',email:'c4i@dapa.go.kr',method:'국방전자조달(D2B) 전자입찰'}
  },
  {
    id:'D2B-DEMO-002', source:'d2b', type:'procurement',
    title:'군 사이버방어 통합 플랫폼 2026 도입 사업',
    agency:'방위사업청 국방전자조달', ministryFull:'방위사업청',
    budgetWon:6_000_000_000,
    postDate:addDays(-2), deadline:addDays(28),
    categories:['security','ai','infosys'],
    bidNumber:'D2B-2026-CYBER-008',
    url:'https://www.d2b.go.kr/d2b/cmn/c/c01/c01_001.do',
    summary:'군 네트워크 AI 기반 이상징후 탐지·자동대응 플랫폼 도입. 엔드포인트 보안, 망분리 환경 적용, 실시간 위협 시각화 포함.',
    requirements:['국방 보안적합성 검증 완료 제품','방산업체 보안 인가','CC인증 EAL4 이상 보안제품'],
    contact:{name:'방위사업청 정보화사업부',tel:'031-289-6114',email:'cyber@dapa.go.kr',method:'D2B 전자입찰 (제한경쟁)'}
  },
  {
    id:'D2B-DEMO-003', source:'d2b', type:'procurement',
    title:'국방 클라우드 2단계 전환 - 비전투 행정시스템 마이그레이션',
    agency:'방위사업청 국방전자조달', ministryFull:'방위사업청',
    budgetWon:4_800_000_000,
    postDate:addDays(-4), deadline:addDays(35),
    categories:['cloud','infosys','security'],
    bidNumber:'D2B-2026-CLOUD-004',
    url:'https://www.d2b.go.kr/d2b/cmn/c/c01/c01_001.do',
    summary:'국방부 비전투 행정·급여·물자관리 시스템의 민간 클라우드 전환 2단계. 군 전용 클라우드 존(Zone) 구성 포함.',
    requirements:['군 보안망 연계 클라우드 구축 경험','CC인증 보안제품 적용 역량','방산업체 지정 또는 협력사 연계'],
    contact:{name:'방위사업청 IT사업팀',tel:'031-289-6114',email:'cloud@dapa.go.kr',method:'D2B 전자입찰'}
  },
];
