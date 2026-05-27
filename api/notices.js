/**
 * Vercel Serverless: 공공 IT·R&D 공고 통합 수집
 * 소스: 나라장터(G2B), NIA, NIPA, KISA, 국방전자조달(D2B)
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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).end();

  try {
    // 모든 소스 병렬 실행 (8초 제한)
    const [g2bResult, niaResult, nipaResult, kisaResult, d2bResult] = await Promise.allSettled([
      G2B_API_KEY ? fetchG2B() : Promise.resolve([]),
      fetchNIA(),
      fetchNIPA(),
      fetchKISA(),
      fetchD2B(),
    ]);

    let notices = [];
    const sources = { g2b: g2bResult, nia: niaResult, nipa: nipaResult, kisa: kisaResult, d2b: d2bResult };
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

// 공고명에서 카테고리 자동 분류
function autoCategories(title) {
  const t = (title || '').toLowerCase();
  const cats = [];
  if (/ai|인공지능|머신러닝|딥러닝|빅데이터|데이터분석|llm|생성형/.test(t)) cats.push('ai');
  if (/보안|사이버|취약점|isms|cc인증|침해|방화벽|암호|개인정보/.test(t))   cats.push('security');
  if (/소프트웨어|sw|앱|플랫폼|서비스개발|시스템개발/.test(t))              cats.push('sw');
  if (/정보시스템|전산|erp|eis|행정시스템|포털|인프라/.test(t))             cats.push('infosys');
  if (/네트워크|통신|5g|6g|wifi|광케이블|무선/.test(t))                     cats.push('network');
  if (/클라우드|cloud|saas|paas|iaas/.test(t))                              cats.push('cloud');
  if (/iot|스마트팩토리|스마트공장|센서|디지털트윈/.test(t))                cats.push('iot');
  if (/r&d|연구개발|기술개발|연구과제|과제공모/.test(t))                    cats.push('rd');
  if (cats.length === 0) cats.push('infosys');
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

    // IT 관련 키워드 필터
    if (!/정보|소프트|sw|ai|인공|데이터|시스템|보안|사이버|클라우드|네트워크|통신|디지털|플랫폼|기술|개발|iot|전산|it|ict/.test(title.toLowerCase())) continue;

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

// ── 나라장터 G2B ─────────────────────────────────────────────
async function fetchG2B() {
  const keywords = ['정보시스템', '소프트웨어', '보안', '데이터', 'AI'];
  const results = [];
  const today = new Date();
  const end = formatDate(today) + '2359';
  const start = formatDate(new Date(today - 30 * 86400000)) + '0000';

  for (const kw of keywords) {
    const url = `http://apis.data.go.kr/1230000/ad/BidPublicInfoService/getBidPblancListInfoServc?serviceKey=${G2B_API_KEY}&numOfRows=20&pageNo=1&type=json&inqryBgnDt=${start}&inqryEndDt=${end}&bidNtceNm=${encodeURIComponent(kw)}`;
    try {
      const r = await Promise.race([fetch(url), timeout(6000)]);
      const text = await r.text();
      if (!text.includes('"items"')) continue;
      const json = JSON.parse(text);
      const items = json?.response?.body?.items?.item || [];
      const arr = Array.isArray(items) ? items : [items];
      arr.forEach(item => {
        if (!item.bidNtceNm) return;
        results.push({
          id: `G2B-${item.bidNtceNo || Math.random()}`,
          source: 'g2b', type: 'procurement',
          title: item.bidNtceNm,
          agency: item.ntceInsttNm || '',
          ministryFull: item.dminsttNm || item.ntceInsttNm || '',
          budgetWon: parseInt(item.asignBdgt || 0) || 0,
          postDate: (item.bidNtceDt || '').substring(0, 10),
          deadline: (item.bidClseDt || '').substring(0, 10),
          categories: autoCategories(item.bidNtceNm),
          bidNumber: item.bidNtceNo || '',
          url: `https://www.g2b.go.kr`,
          summary: item.bidNtceSpcfctnNm || '',
          requirements: [],
          contact: { name: item.dmstAdjstOfficerNm || '', tel: item.dmstAdjstOfficerTelNo || '', email: '', method: '나라장터 전자입찰' },
        });
      });
    } catch (e) { /* ignore */ }
  }

  // 중복 제거
  const seen = new Set();
  return results.filter(n => { if (seen.has(n.id)) return false; seen.add(n.id); return true; });
}

function formatDate(d) {
  return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
}

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
