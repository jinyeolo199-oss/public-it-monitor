/**
 * Vercel Serverless Function: 공공 IT·R&D 공고 통합 수집
 *
 * ── API 키 설정 방법 ──
 * Vercel 프로젝트 대시보드 → Settings → Environment Variables 에서 설정:
 *   G2B_API_KEY  : data.go.kr 에서 "입찰공고정보서비스" 인증키 발급
 *   NTIS_API_KEY : www.ntis.go.kr Open API 키 발급
 *
 * API 키 없을 경우: 503 반환 → 프론트가 내장 데모데이터 사용
 */

const G2B_API_KEY  = process.env.G2B_API_KEY  || '';
const NTIS_API_KEY = process.env.NTIS_API_KEY || '';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')     return res.status(405).end();

  try {
    let notices = [];

    // ── 1. 나라장터 G2B ──────────────────────────────────────────
    // API 발급: https://www.data.go.kr/data/15000755/openapi.do
    if (G2B_API_KEY) {
      const g2b = await fetchG2B(G2B_API_KEY);
      notices = notices.concat(g2b);
    }

    // ── 2. NTIS R&D 과제 ─────────────────────────────────────────
    // API 발급: https://www.ntis.go.kr/rndGov/openapi/index.do
    if (NTIS_API_KEY) {
      const ntis = await fetchNTIS(NTIS_API_KEY);
      notices = notices.concat(ntis);
    }

    if (notices.length === 0) {
      // API 키 미설정 → 503 → 프론트가 데모데이터 표시
      return res.status(503).json({ error: 'API_KEYS_NOT_CONFIGURED' });
    }

    // 마감일 기준 정렬
    notices.sort((a, b) => {
      if (!a.deadline) return 1;
      if (!b.deadline) return -1;
      return a.deadline.localeCompare(b.deadline);
    });

    return res.status(200).json(notices);
  } catch (err) {
    console.error('[notices API]', err);
    return res.status(500).json({ error: err.message });
  }
}

// ── 나라장터 G2B 입찰공고 조회 ────────────────────────────────
async function fetchG2B(apiKey) {
  // IT 관련 업무구분 코드: YONG(용역), SW(소프트웨어), CONS(정보통신공사)
  const targets = [
    { bsnsDivCd: 'YONG', keyword: '정보통신' },
    { bsnsDivCd: 'YONG', keyword: '소프트웨어' },
    { bsnsDivCd: 'YONG', keyword: '시스템' },
  ];

  const results = [];
  for (const t of targets) {
    const url = [
      'http://apis.data.go.kr/1230000/ad/BidPublicInfoService/getBidPblancListInfoServc',
      `?serviceKey=${encodeURIComponent(apiKey)}`,
      `&numOfRows=30&pageNo=1&type=json`,
      `&bidNtceNm=${encodeURIComponent(t.keyword)}`,
    ].join('');

    try {
      const r = await fetch(url);
      const json = await r.json();
      const items = json?.response?.body?.items?.item || [];
      const arr = Array.isArray(items) ? items : [items];

      arr.forEach(item => {
        results.push({
          id: `G2B-${item.bidNtceNo}`,
          source: 'g2b',
          type: 'procurement',
          title: item.bidNtceNm || '',
          agency: item.ntceInsttNm || '',
          ministryFull: item.dminsttNm || item.ntceInsttNm || '',
          budgetWon: parseInt(item.asignBdgt || '0') || 0,
          postDate: (item.bidNtceDt || '').substring(0, 10),
          deadline: (item.bidClseDt || '').substring(0, 10),
          categories: autoCategories(item.bidNtceNm || ''),
          bidNumber: item.bidNtceNo || '',
          url: `https://www.g2b.go.kr/pt/menu/selectSubFrame.do?framesrc=/pt/menu/frameTgong.do?url=https://www.g2b.go.kr:8101/ep/tbid/tbidList.do?openBidNo=${item.bidNtceNo}`,
          summary: item.bidNtceSpcfctnNm || '',
          requirements: [],
          contact: {
            name: item.dmstAdjstOfficerNm || '',
            tel:  item.dmstAdjstOfficerTelNo || '',
            email: '',
            method: '나라장터 전자입찰',
          },
        });
      });
    } catch (e) {
      console.warn('[G2B fetch error]', e.message);
    }
  }

  // 중복 제거
  const seen = new Set();
  return results.filter(n => {
    if (seen.has(n.id)) return false;
    seen.add(n.id);
    return true;
  });
}

// ── NTIS R&D 과제 공모 조회 ───────────────────────────────────
async function fetchNTIS(apiKey) {
  // NTIS API 상세: https://www.ntis.go.kr/rndGov/openapi/index.do
  // 실제 엔드포인트/파라미터는 발급 후 매뉴얼 참조
  const url = [
    'https://apis.ntis.go.kr/rndGov/rndPrjcList',
    `?serviceKey=${encodeURIComponent(apiKey)}`,
    `&numOfRows=50&pageNo=1&resultType=json`,
    `&taskSeCodeList=ICT`,  // ICT 분야
  ].join('');

  try {
    const r = await fetch(url);
    const json = await r.json();
    const items = json?.dataSearch?.content || [];
    return items.map(item => ({
      id: `NTIS-${item.taskId || Math.random()}`,
      source: 'ntis',
      type: 'rd',
      title: item.taskNm || '',
      agency: item.excInsttNm || '',
      ministryFull: item.excInsttNm || '',
      budgetWon: parseInt(item.taskBdgtAmt || '0') || 0,
      postDate: (item.taskBeginYmd || '').substring(0, 10),
      deadline: (item.taskEndYmd || '').substring(0, 10),
      categories: autoCategories(item.taskNm || ''),
      bidNumber: item.taskId || '',
      url: `https://www.ntis.go.kr/rndGov/rndPrjcView.do?taskId=${item.taskId}`,
      summary: item.taskSmryNm || '',
      requirements: [],
      contact: { name: '', tel: '', email: '', method: 'NTIS 연구관리시스템' },
    }));
  } catch (e) {
    console.warn('[NTIS fetch error]', e.message);
    return [];
  }
}

// ── 공고명 자동 카테고리 분류 ──────────────────────────────────
function autoCategories(title) {
  const t = title.toLowerCase();
  const cats = [];
  if (/ai|인공지능|머신러닝|딥러닝|빅데이터|데이터분석|llm/.test(t)) cats.push('ai');
  if (/보안|사이버|취약점|isms|cc인증|침해|방화벽/.test(t))            cats.push('security');
  if (/소프트웨어|sw|앱|플랫폼|서비스개발/.test(t))                   cats.push('sw');
  if (/정보시스템|전산|erp|eis|행정시스템|포털/.test(t))               cats.push('infosys');
  if (/네트워크|통신|5g|6g|wifi|광케이블/.test(t))                     cats.push('network');
  if (/클라우드|cloud|saas|paas|iaas/.test(t))                         cats.push('cloud');
  if (/iot|스마트팩토리|스마트공장|센서|디지털트윈/.test(t))           cats.push('iot');
  if (/r&d|연구개발|기술개발|연구과제/.test(t))                         cats.push('rd');
  if (cats.length === 0) cats.push('infosys');
  return cats;
}
