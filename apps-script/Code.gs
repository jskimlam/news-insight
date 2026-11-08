// =====================================================================
// 케미칼 뉴스 인사이트 - Apps Script 백엔드 (Code.gs)
// ---------------------------------------------------------------------
// 역할: 구글시트(원장)와 GitHub Pages 화면(index.html) 사이의 API
//   GET  ?action=ping                  : 연결 확인
//   GET  ?action=dates                 : 기사가 있는 날짜 목록과 건수
//   GET  ?action=edition&date=YYYY-MM-DD : 그날 한 판(가벼운 정보만)
//   GET  ?action=article&id=...        : 기사 한 건(전문 해석, 영어 원문 포함)
//   GET  ?action=search&q=...          : 전체 기간 검색
//   POST {action:'register'|'auth'|'update', key, ...} : 기사 등록 / 비밀번호 확인 / 분류 수정 (모두 등록 키 필요)
// 설치: 구글시트 > 확장 프로그램 > Apps Script 에 이 코드를 통째로 붙여넣기
// =====================================================================

// ---------------------------------------------------------------------
// 설정 상수
// ---------------------------------------------------------------------
// 기사를 쌓는 구글시트 ID (시트 주소에서 /d/ 와 /edit 사이의 값)
const SPREADSHEET_ID = '1aRLaJy0aZplPprC5F1tLT1ZRwgQO7x7t1t4Bfz8DyeM';
// 날짜 계산과 표시에 쓰는 시간대 (한국 시간)
const TZ = 'Asia/Seoul';
// 1면에 쓰는 가벼운 열의 개수 (A~L열)
const LIGHT_COLS = 12;
// 기사를 열 때만 읽는 무거운 열의 시작 번호 (M열 = 13번째)
const HEAVY_START_COL = 13;
// 시트 전체 열의 개수 (A~S열)
const TOTAL_COLS = 19;
// 화면과 맞추기 위한 백엔드 버전 (화면이 이 값을 확인해 예전 코드로 저장하는 사고를 막음)
const API_VERSION = 5;
// 셀 하나에 안전하게 넣을 최대 글자 수 (구글시트 한도는 5만 자)
const CELL_LIMIT = 45000;
// 월 탭 맨 윗줄에 들어가는 머리글 (순서를 바꾸면 안 됨)
const HEADERS = ['id', '날짜', '출처', '품목태그', '제목(한글)', '제목(영문)', '한 줄 요약', '핵심 포인트', '가격영향', '중요도', '원문URL', '등록일시', '전문 해석', '전문 해석(이어서)', '영어 원문', '영어 원문(이어서)', '시사점', '작성자', '최종업데이트'];
// 새 월 탭의 열 너비 (픽셀) - 머리글 순서와 같음
const COL_WIDTHS = [110, 90, 80, 80, 260, 260, 320, 320, 70, 70, 180, 140, 200, 200, 200, 200, 300, 140, 160];
// 가격영향 입력 허용 값
const IMPACT_VALUES = ['상승', '하락', '중립'];
// 중요도 입력 허용 값
const IMPORTANCE_VALUES = ['높음', '중립', '보통', '낮음'];
// 품목 태그 허용 값
const TAG_VALUES = ['SM', 'AN', 'BD', 'MMA', 'BPA', 'WTI', 'ABS', 'PC', 'PMMA', 'PS', 'HIPS', 'EPS', '기타'];
// 지난 날짜 한 판을 캐시에 보관하는 시간(초) - 6시간(캐시 최대치)
const TTL_PAST = 21600;
// 오늘·최신 날짜 한 판을 캐시에 보관하는 시간(초) - 10분
const TTL_RECENT = 600;
// 검색 결과 최대 건수
const SEARCH_LIMIT = 60;

// ---------------------------------------------------------------------
// 웹앱 진입점: GET 요청 (읽기)
// ---------------------------------------------------------------------
function doGet(e) {
  try {
    // 주소 뒤에 붙은 파라미터 묶음 (없으면 빈 객체)
    const p = (e && e.parameter) || {};
    // 요청 종류 (없으면 연결 확인)
    const action = p.action || 'ping';
    // 연결 확인
    if (action === 'ping') return output_(ping_(), e);
    // 날짜 목록
    if (action === 'dates') return output_(getDates_(), e);
    // 하루 한 판
    if (action === 'edition') return output_(getEdition_(p.date), e);
    // 기사 한 건
    if (action === 'article') return output_(getArticle_(p.id), e);
    // 전체 기간 검색
    if (action === 'search') return output_(searchArticles_(p.q), e);
    // 위에 해당하지 않으면 안내문 반환
    return output_(fail_('알 수 없는 요청입니다.', 'BAD_ACTION'), e);
  } catch (err) {
    // 예상하지 못한 오류는 로그에 남기고 한글 안내문으로 응답
    console.error(err);
    return output_(fail_('서버에서 오류가 발생했습니다: ' + err.message, 'SERVER_ERROR'), e);
  }
}

// ---------------------------------------------------------------------
// 웹앱 진입점: POST 요청 (기사 등록)
// ---------------------------------------------------------------------
function doPost(e) {
  try {
    // 요청 본문 문자열 (없으면 빈 JSON)
    const raw = (e && e.postData && e.postData.contents) || '{}';
    // 문자열을 객체로 변환
    let body;
    try {
      body = JSON.parse(raw);
    } catch (parseErr) {
      // JSON 형식이 아니면 안내문 반환
      return output_(fail_('보낸 내용을 읽을 수 없습니다. 화면을 새로고침한 뒤 다시 시도하세요.', 'BAD_JSON'), e);
    }
    // 요청 종류: auth(비밀번호 확인), update(분류 수정), 그 외는 기사 등록
    const action = body.action || 'register';
    if (action === 'auth') return output_(checkKey_(body.key) || { ok: true, message: '확인되었습니다.' }, e);
    if (['lookup','trashList','delete','restore'].includes(action)) return output_(newsAdmin_(body), e);
    if (action === 'update') return output_(updateArticle_(body), e);
    // 기사 등록 처리 후 결과 반환
    return output_(registerArticle_(body), e);
  } catch (err) {
    // 예상하지 못한 오류는 로그에 남기고 한글 안내문으로 응답
    console.error(err);
    return output_(fail_('저장 중 오류가 발생했습니다: ' + err.message, 'SERVER_ERROR'), e);
  }
}

// ---------------------------------------------------------------------
// 응답 만들기
// ---------------------------------------------------------------------
// 객체를 JSON(또는 callback이 있으면 JSONP)으로 내보냄
function output_(obj, e) {
  // 객체를 JSON 문자열로 변환
  const json = JSON.stringify(obj);
  // JSONP용 함수 이름 (CORS가 막힐 때의 대비책)
  const cb = e && e.parameter && e.parameter.callback;
  // 함수 이름이 안전한 형식일 때만 JSONP로 응답
  if (cb && /^[A-Za-z_$][\w$.]*$/.test(cb)) {
    return ContentService.createTextOutput(cb + '(' + json + ');').setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  // 기본은 JSON 응답
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

// 실패 응답 객체 만들기
function fail_(message, code, extra) {
  // 기본 필드: 실패 표시, 코드, 한글 안내문
  const res = { ok: false, code: code || 'ERROR', message: message };
  // 추가 정보가 있으면 합치기
  if (extra) Object.keys(extra).forEach(function (k) { res[k] = extra[k]; });
  return res;
}

// ---------------------------------------------------------------------
// 읽기 기능
// ---------------------------------------------------------------------
// 연결 확인: 월 탭 이름 목록과 현재 시각을 돌려줌
function ping_() {
  // 시트 열기
  const ss = openSs_();
  // 월 탭 이름만 모으기
  const tabs = monthSheets_(ss).map(function (s) { return s.getName(); });
  // 연결 성공 응답
  return { ok: true, version: API_VERSION, message: '연결되었습니다.', tabs: tabs, now: Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm') };
}

// 기사가 있는 날짜와 건수 목록
function getDates_() {
  // 캐시에 있으면 그대로 사용
  const key = ck_('dates');
  const cached = cacheGet_(key);
  if (cached) return cached;
  // 시트 열기
  const ss = openSs_();
  // 날짜별 건수를 모을 객체
  const counts = {};
  // 모든 월 탭을 돌면서 B열(날짜)만 읽음
  monthSheets_(ss).forEach(function (sh) {
    // 데이터가 있는 마지막 행
    const last = sh.getLastRow();
    // 머리글뿐이면 건너뜀
    if (last < 2) return;
    // 날짜 열 전체를 한 번에 읽어 건수 집계
    sh.getRange(2, 1, last - 1, 2).getValues().forEach(function (r) {
      // 날짜를 YYYY-MM-DD 문자열로 통일
      if (String(r[0]).startsWith('trash:')) return;
      const d = normDate_(r[1]);
      // 올바른 날짜만 집계
      if (d) counts[d] = (counts[d] || 0) + 1;
    });
  });
  // 오래된 날짜부터 정렬한 목록
  const dates = Object.keys(counts).sort().map(function (d) { return { date: d, count: counts[d] }; });
  // 최신 날짜 포함한 응답
  const result = { ok: true, dates: dates, latest: dates.length ? dates[dates.length - 1].date : null };
  // 10분 동안 캐시
  cachePut_(key, result, TTL_RECENT);
  return result;
}

// 하루 한 판: 그날 기사의 가벼운 정보만 돌려줌
function getEdition_(date) {
  // 날짜 형식 검사
  if (!isValidDate_(date)) return fail_('날짜 형식이 올바르지 않습니다. (예: 2026-11-01)', 'BAD_DATE');
  // 캐시 확인
  const key = ck_('ed:' + date);
  const cached = cacheGet_(key);
  if (cached) return cached;
  // 시트 열기
  const ss = openSs_();
  // 해당 월 탭 (예: 2026-11)
  const sh = ss.getSheetByName(date.slice(0, 7));
  // 탭이 있으면 읽어서 그날 기사만 남기고, 없으면 빈 목록
  const articles = sh ? readLightRows_(sh).filter(function (a) { return a.date === date; }) : [];
  // 응답 객체
  const result = { ok: true, date: date, articles: articles };
  // 지난 날짜는 오래, 오늘 이후는 짧게 캐시
  cachePut_(key, result, date < today_() ? TTL_PAST : TTL_RECENT);
  return result;
}

// 기사 한 건: 가벼운 정보 + 전문 해석 + 영어 원문
function getArticle_(id) {
  // id 형식 검사 (예: 20261101-001)
  if (!/^\d{8}-\d{3,}$/.test(id || '')) return fail_('기사 번호 형식이 올바르지 않습니다.', 'BAD_ID');
  // 캐시 확인
  const key = ck_('ar:' + id);
  const cached = cacheGet_(key);
  if (cached) return cached;
  // 시트 열기
  const ss = openSs_();
  // id 앞 6자리로 월 탭 이름 만들기 (202611 -> 2026-11)
  const sh = ss.getSheetByName(id.slice(0, 4) + '-' + id.slice(4, 6));
  // 탭이 없으면 못 찾았다고 응답
  if (!sh) return fail_('기사를 찾을 수 없습니다.', 'NOT_FOUND');
  // 마지막 행
  const last = sh.getLastRow();
  // 기사가 하나도 없으면 못 찾았다고 응답
  if (last < 2) return fail_('기사를 찾을 수 없습니다.', 'NOT_FOUND');
  // id 열만 읽어서 위치 찾기
  const ids = sh.getRange(2, 1, last - 1, 1).getValues().map(function (r) { return String(r[0]).trim(); });
  // 몇 번째 행인지 (없으면 -1)
  const idx = ids.indexOf(id);
  // 못 찾으면 안내문
  if (idx < 0) return fail_('기사를 찾을 수 없습니다.', 'NOT_FOUND');
  // 해당 한 행만 읽기 (가벼운 열 + 무거운 열)
  const row = sh.getRange(idx + 2, 1, 1, TOTAL_COLS).getValues()[0];
  // 가벼운 정보를 객체로 변환
  const article = rowToLight_(row);
  // 전문 해석 두 칸을 이어 붙인 마크다운 글 (화면이 소제목, 목록, 굵은 글씨를 그려 줌)
  article.bodyKo = (String(row[HEAVY_START_COL - 1] || '') + String(row[HEAVY_START_COL] || '')).trim();
  // 예전 화면과의 호환을 위해 문단 배열도 함께 제공
  article.paragraphsKo = splitParagraphs_(article.bodyKo);
  // 시사점 (Q열): 줄마다 '제목||본문'
  article.insights = parsePairs_(row[16]);
  // 작성자 (R열), 최종 업데이트 (S열)
  article.author = String(row[17] || '').trim();
  article.updatedAt = String(row[18] || '').trim();
  // 영어 원문 두 칸을 이어 붙여 문단별로 나눔
  article.paragraphsEn = splitParagraphs_(String(row[HEAVY_START_COL + 1] || '') + String(row[HEAVY_START_COL + 2] || ''));
  // 응답 객체
  const result = { ok: true, article: article };
  // 6시간 캐시 (값이 너무 크면 건너뜀)
  cachePut_(key, result, TTL_PAST);
  return result;
}

// 전체 기간 검색: 제목, 요약, 핵심 포인트에서 찾음
function searchArticles_(q) {
  // 검색어 정리
  const word = String(q || '').trim().toLowerCase();
  // 너무 짧으면 안내문
  if (word.length < 2) return fail_('검색어는 두 글자 이상 입력하세요.', 'SHORT_QUERY');
  // 시트 열기
  const ss = openSs_();
  // 결과를 모을 배열
  const found = [];
  // 최근 달부터 돌기 위해 탭 이름 역순 정렬
  monthSheets_(ss).sort(function (a, b) { return a.getName() < b.getName() ? 1 : -1; }).forEach(function (sh) {
    // 이미 충분히 모았으면 건너뜀
    if (found.length >= SEARCH_LIMIT) return;
    // 탭의 가벼운 정보를 모두 읽어 검색어가 들어간 기사만 담음
    readLightRows_(sh).forEach(function (a) {
      // 검색 대상 글자를 하나로 합침
      const hay = (a.titleKo + ' ' + a.titleEn + ' ' + a.oneLine + ' ' + a.points.map(function (p) { return p.head + ' ' + p.body; }).join(' ')).toLowerCase();
      // 포함되면 결과에 추가
      if (hay.indexOf(word) >= 0) found.push(a);
    });
  });
  // 날짜 최신순, 같은 날은 id 큰 순으로 정렬
  found.sort(function (a, b) { return a.date === b.date ? (a.id < b.id ? 1 : -1) : (a.date < b.date ? 1 : -1); });
  // 최대 건수까지만 응답
  return { ok: true, q: String(q).trim(), articles: found.slice(0, SEARCH_LIMIT) };
}

// ---------------------------------------------------------------------
// 등록 기능
// ---------------------------------------------------------------------
// 등록 키(비밀번호) 확인: 맞으면 null, 틀리면 실패 응답 객체
function checkKey_(key) {
  // 스크립트 속성에 저장된 등록 키
  const savedKey = PropertiesService.getScriptProperties().getProperty('REGISTER_KEY');
  // 키가 설정되지 않았으면 사용 불가
  if (!savedKey) return fail_('등록 키가 설정되지 않았습니다. Apps Script 프로젝트 설정의 스크립트 속성에 REGISTER_KEY를 추가하세요.', 'NO_KEY');
  // 보낸 키와 비교
  if (String(key || '') !== savedKey) return fail_('비밀번호가 올바르지 않습니다.', 'BAD_KEY');
  return null;
}

// 기사 한 건의 분류(중요도, 가격영향, 품목 태그)를 수정: 보낸 항목만 바꿈
function updateArticle_(body) {
  // 비밀번호 확인
  const badKey = checkKey_(body.key);
  if (badKey) return badKey;
  // 기사 번호 검사
  const id = String(body.id || '');
  if (!/^\d{8}-\d{3,}$/.test(id)) return fail_('기사 번호 형식이 올바르지 않습니다.', 'BAD_ID');
  // 바꿀 값을 검사하며 모음
  const upd = {};
  if (body.impact != null) {
    if (IMPACT_VALUES.indexOf(body.impact) < 0) return fail_('가격영향은 상승, 하락, 중립 중에서 고르세요.', 'INVALID');
    upd.impact = body.impact;
  }
  if (body.importance != null) {
    if (IMPORTANCE_VALUES.indexOf(body.importance) < 0) return fail_('중요도는 높음, 중립, 보통, 낮음 중에서 고르세요.', 'INVALID');
    upd.importance = body.importance;
  }
  if (body.tags != null) upd.tags = normTags_(body.tags);
  // 바꿀 항목이 하나도 없으면 안내
  if (!Object.keys(upd).length) return fail_('바꿀 항목이 없습니다.', 'NOTHING');
  // 동시에 같은 행을 고치지 않도록 잠금
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return fail_('다른 저장이 진행 중입니다. 잠시 후 다시 시도하세요.', 'BUSY');
  try {
    // 기사가 있는 월 탭 찾기
    const sh = openSs_().getSheetByName(id.slice(0, 4) + '-' + id.slice(4, 6));
    if (!sh || sh.getLastRow() < 2) return fail_('기사를 찾을 수 없습니다.', 'NOT_FOUND');
    // id 열에서 행 위치 찾기
    const ids = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().map(function (r) { return String(r[0]).trim(); });
    const idx = ids.indexOf(id);
    if (idx < 0) return fail_('기사를 찾을 수 없습니다.', 'NOT_FOUND');
    const rowNo = idx + 2;
    // 품목 태그(D열), 가격영향(I열), 중요도(J열)만 수정
    if (upd.tags) sh.getRange(rowNo, 4).setValue(upd.tags.join(','));
    if (upd.impact) sh.getRange(rowNo, 9).setValue(upd.impact);
    if (upd.importance) sh.getRange(rowNo, 10).setValue(upd.importance);
    SpreadsheetApp.flush();
    // 캐시 버전을 올려 화면에 바로 반영되게 함
    bumpCacheVer_();
    return { ok: true, id: id, message: '수정했습니다.' };
  } finally {
    // 오류가 나도 잠금은 반드시 해제
    lock.releaseLock();
  }
}

// 품목 태그 입력(배열 또는 쉼표 문자열)을 허용 값만 남겨 정리, 없으면 기타
function normTags_(raw) {
  const list = (Array.isArray(raw) ? raw : String(raw || '').split(/[,\s]+/)).map(function (t) { return String(t).trim().toUpperCase(); }).filter(function (t) { return TAG_VALUES.indexOf(t) >= 0; });
  // 중복 제거
  const uniq = list.filter(function (t, i) { return list.indexOf(t) === i; });
  if (!uniq.length) uniq.push('기타');
  return uniq;
}

// 기사 한 건을 월 탭에 추가
function registerArticle_(body) {
  // 등록 키(비밀번호) 확인
  const badKey = checkKey_(body.key);
  if (badKey) return badKey;
  // 보낸 기사 내용을 검사하고 정리
  const checked = normalizeInput_(body.article || {});
  // 문제가 있으면 한글 안내문 반환
  if (checked.error) return fail_(checked.error, 'INVALID');
  // 검사를 통과한 기사 데이터
  const a = checked.value;
  // 같은 시각에 두 번 저장되어 번호가 겹치지 않도록 잠금
  const lock = LockService.getScriptLock();
  // 20초 안에 잠금을 못 얻으면 안내문 반환
  if (!lock.tryLock(20000)) return fail_('다른 저장이 진행 중입니다. 잠시 후 다시 시도하세요.', 'BUSY');
  try {
    // 시트 열기
    const ss = openSs_();
    // 월 탭 이름 (예: 2026-11)
    const tabName = a.date.slice(0, 7);
    // 탭이 있으면 가져오고 없으면 새로 만듦
    const sh = ss.getSheetByName(tabName) || createMonthSheet_(ss, tabName);
    // 기존 기사 목록 (중복 검사와 번호 계산용)
    const lead = newsLead_(body.article.leadText || a.bodyEn, a.titleEn);
    const records = newsRecords_(ss, a.date);
    const rows = records.filter(r => r.sh.getName() === tabName).map(r => ({...r.a,id:r.a.id.replace(/^trash:/,'')}));
    const auto = body.action === 'ingest';
    const hit = records.find(r => sameNews_(r, a, auto && body.hash) || sameLead_(r,a,lead));
    if (auto && (!a.url || !/^[a-f0-9]{64}$/.test(body.hash))) return fail_('원문 식별 정보 확인 필요','INVALID');
    if (hit && hit.removed) return fail_('삭제한 기사입니다.', 'DELETED');
    if (hit && sameLead_(hit,a,lead)) return auto ? {ok:true,id:hit.a.id,state:"existing"} : fail_("같은 출처·발행일·첫 문장의 기사가 이미 있습니다.", "SAME_LEAD", {existingId:hit.a.id});
    if (auto && hit && (!hit.meta.hash || body.hash === hit.meta.hash)) return {ok:true,id:hit.a.id,state:'existing'};
    // 강제 저장이 아니면 중복 검사
    if (!auto && !body.force) {
      // 같은 URL이거나, 같은 날 같은 제목이면 중복으로 판단
      const dup = rows.find(function (r) {
        return (a.url && r.url === a.url) || (r.date === a.date && (r.titleKo === a.titleKo || (a.titleEn && r.titleEn.toLowerCase() === a.titleEn.toLowerCase())));
      });
      // 중복이면 저장하지 않고 알림
      if (dup) return fail_('같은 기사가 이미 있습니다: ' + dup.titleKo + ' (' + dup.id + ')', 'DUPLICATE', { existingId: dup.id });
    }
    // id 앞부분 (예: 20261101-)
    const prefix = a.date.replace(/-/g, '') + '-';
    // 그날 가장 큰 일련번호 찾기
    let maxSeq = 0;
    rows.forEach(function (r) {
      // 같은 날짜 id만 비교
      if (r.id.indexOf(prefix) === 0) maxSeq = Math.max(maxSeq, parseInt(r.id.slice(prefix.length), 10) || 0);
    });
    // 새 id = 날짜 + 3자리 일련번호
    const id = auto && hit ? hit.a.id : prefix + String(maxSeq + 1).padStart(3,'0');
    // 긴 본문은 두 칸으로 나눔
    const ko = splitChunks_(a.bodyKo);
    const en = splitChunks_(a.bodyEn);
    // 글자 수가 두 칸 한도를 넘으면 안내문 반환
    if (!ko || !en) return fail_('본문이 너무 깁니다. 한 칸 4만 5천 자씩 두 칸(총 9만 자)까지 저장할 수 있습니다.', 'TOO_LONG');
    // 등록 시각 문자열
    const nowStr = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm');
    // 새로 쓸 행 번호
    const target = auto && hit ? hit.sh : sh;
    const rowNo = auto && hit ? hit.row : target.getLastRow() + 1;
    // 행이 모자라면 200행 추가
    if (rowNo > target.getMaxRows()) target.insertRowsAfter(target.getMaxRows(), 200);
    // 쓸 범위 (한 행, 16열)
    if ((auto || lead) && target.getMaxColumns()<20) target.insertColumnAfter(19);
    const range = target.getRange(rowNo, 1, 1, (auto || lead) ? 20 : TOTAL_COLS);
    target.getRange(rowNo,10).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(IMPORTANCE_VALUES,true).setAllowInvalid(false).build());
    // 날짜나 수식으로 바뀌지 않도록 일반 텍스트 서식 적용
    range.setNumberFormat('@');
    // 값 채우기 (머리글 순서와 동일)
    const values = [id, hit && auto ? hit.a.date : a.date, a.source, a.tags.join(','), a.titleKo, a.titleEn, a.oneLine, joinPairs_(a.points), a.impact, a.importance, a.url, nowStr, ko[0], ko[1], en[0], en[1], joinPairs_(a.insights), a.author, a.updatedAt];
    if (auto) {
      if (hit) {
        values[3]=hit.a.tags.join(','); values[8]=hit.a.impact; values[9]=hit.a.importance; values[11]=hit.a.createdAt;
      }
      values.push(JSON.stringify({lead:lead,hash:body.hash,aliases:Array.from(new Set([...(hit && hit.meta.aliases || []),articleKey_(a.url)]))}));
    }
    if (!auto && lead) values.push(JSON.stringify({lead:lead}));
    range.setValues([values.map(v => typeof v === 'string' && v.startsWith('=') ? "'"+v : v)]);
    // 행 높이가 늘어나지 않도록 잘라서 표시
    range.setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP);
    // 위쪽 정렬
    range.setVerticalAlignment('top');
    // 시트에 즉시 반영
    SpreadsheetApp.flush();
    // 캐시 버전을 올려 이전 캐시를 무효화
    bumpCacheVer_();
    // 성공 응답
    return { ok: true, id: id, date: a.date, tab: tabName, message: '저장했습니다.' };
  } finally {
    // 오류가 나도 잠금은 반드시 해제
    lock.releaseLock();
  }
}

// 등록 요청 내용 검사 및 정리 (문제가 있으면 error, 정상이면 value)
function normalizeInput_(b) {
  // 날짜 (YYYY-MM-DD)
  const date = normDate_(b.date);
  if (!date || !isValidDate_(date)) return { error: '날짜를 YYYY-MM-DD 형식으로 입력하세요.' };
  // 한글 제목 (필수)
  const titleKo = cut_(b.titleKo, 300);
  if (!titleKo) return { error: '한글 제목을 입력하세요.' };
  // 영문 제목 (선택)
  const titleEn = cut_(b.titleEn, 300);
  // 한 줄 요약 (필수)
  const oneLine = cut_(b.oneLine, 1000);
  if (!oneLine) return { error: '한 줄 요약을 입력하세요.' };
  // 핵심 요약: 배열(글자 또는 {head, body}) 또는 줄바꿈 문자열 모두 허용
  const points = normPairs_(Array.isArray(b.points) ? b.points : String(b.points || '').split(/\r?\n/));
  if (!points.length) return { error: '핵심 요약을 한 줄 이상 입력하세요.' };
  if (joinPairs_(points).length > 6000) return { error: '핵심 요약이 너무 깁니다. (6,000자 이내)' };
  // 시사점 (선택)
  const insights = normPairs_(Array.isArray(b.insights) ? b.insights : String(b.insights || '').split(/\r?\n/));
  if (joinPairs_(insights).length > 6000) return { error: '시사점이 너무 깁니다. (6,000자 이내)' };
  // 가격영향 값 검사
  const impact = String(b.impact || '').trim();
  if (IMPACT_VALUES.indexOf(impact) < 0) return { error: '가격영향은 상승, 하락, 중립 중에서 고르세요.' };
  // 중요도 값 검사
  const importance = String(b.importance || '').trim();
  if (IMPORTANCE_VALUES.indexOf(importance) < 0) return { error: '중요도는 높음, 중립, 보통, 낮음 중에서 고르세요.' };
  // 품목 태그: 허용 값만 남기고, 없으면 기타
  const uniqTags = normTags_(b.tags);
  // 원문 URL (선택, 있으면 http로 시작해야 함)
  const url = cut_(b.url, 2000);
  if (url && !/^https?:\/\//i.test(url)) return { error: '원문 URL은 http:// 또는 https:// 로 시작해야 합니다.' };
  // 출처 (비면 기타 매체)
  const source = cut_(b.source, 100) || '기타 매체';
  // 작성자와 최종 업데이트 일시 (선택)
  const author = cut_(b.author, 200);
  const updatedAt = cut_(b.updatedAt, 40);
  // 전문 해석(필수)과 영어 원문(선택), 줄바꿈 정리
  const bodyKo = String(b.bodyKo || '').replace(/\r\n/g, '\n').trim();
  const bodyEn = String(b.bodyEn || '').replace(/\r\n/g, '\n').trim();
  if (!bodyKo) return { error: '전문 해석을 입력하세요.' };
  // 검사를 통과한 값 묶음
  return { value: { date: date, source: source, tags: uniqTags, titleKo: titleKo, titleEn: titleEn, oneLine: oneLine, points: points, impact: impact, importance: importance, url: url, bodyKo: bodyKo, bodyEn: bodyEn, insights: insights, author: author, updatedAt: updatedAt } };
}

// 긴 본문을 두 칸으로 나눔 (두 칸을 이어 붙이면 원문과 같음). 너무 길면 null
function splitChunks_(text) {
  // 한 칸에 들어가면 두 번째 칸은 비움
  if (text.length <= CELL_LIMIT) return [text, ''];
  // 두 칸을 넘으면 저장 불가
  if (text.length > CELL_LIMIT * 2) return null;
  // 한 칸 한도 근처의 문단 경계(빈 줄)를 찾음
  let cut = text.lastIndexOf('\n\n', CELL_LIMIT);
  // 경계가 너무 앞이거나 없으면 한도 위치에서 자름
  if (cut < CELL_LIMIT * 0.5) cut = CELL_LIMIT;
  // 앞부분과 뒷부분 반환
  return [text.slice(0, cut), text.slice(cut)];
}

// ---------------------------------------------------------------------
// 시트 도구
// ---------------------------------------------------------------------
// 시트 열기 (실패하면 한글 안내문으로 오류)
function openSs_() {
  try {
    return SpreadsheetApp.openById(SPREADSHEET_ID);
  } catch (e) {
    throw new Error('구글시트를 열 수 없습니다. SPREADSHEET_ID와 접근 권한을 확인하세요.');
  }
}

// 이름이 YYYY-MM 형식인 월 탭만 모음
function monthSheets_(ss) {
  return ss.getSheets().filter(function (s) { return /^\d{4}-\d{2}$/.test(s.getName()); });
}

// 월 탭에서 가벼운 열(A~L)을 읽어 기사 목록으로 변환
function readLightRows_(sh) {
  // 마지막 행
  const last = sh.getLastRow();
  // 데이터가 없으면 빈 목록
  if (last < 2) return [];
  // 가벼운 열만 한 번에 읽어서 변환하고, id가 빈 행은 제외
  return sh.getRange(2, 1, last - 1, LIGHT_COLS).getValues().map(rowToLight_).filter(function (a) { return a.id && !a.id.startsWith("trash:"); });
}

// 시트 한 행을 기사 객체로 변환
function rowToLight_(r) {
  return {
    id: String(r[0] == null ? '' : r[0]).trim(),
    date: normDate_(r[1]),
    source: String(r[2] || '').trim(),
    tags: String(r[3] || '').split(',').map(function (t) { return t.trim(); }).filter(Boolean),
    titleKo: String(r[4] || '').trim(),
    titleEn: String(r[5] || '').trim(),
    oneLine: String(r[6] || '').trim(),
    points: parsePairs_(r[7]),
    impact: String(r[8] || '').trim(),
    importance: String(r[9] || '').trim(),
    url: String(r[10] || '').trim(),
    createdAt: r[11] instanceof Date ? Utilities.formatDate(r[11], TZ, 'yyyy-MM-dd HH:mm') : String(r[11] || '').trim()
  };
}

// 새 월 탭을 만들고 머리글, 서식, 입력 규칙을 설정
function createMonthSheet_(ss, name) {
  // 맨 앞 위치에 새 탭 추가 (최신 달이 왼쪽)
  const sh = ss.insertSheet(name, 0);
  // 머리글 입력 및 스타일
  sh.getRange(1, 1, 1, TOTAL_COLS).setValues([HEADERS]).setFontWeight('bold').setBackground('#1a1a1a').setFontColor('#ffffff');
  // 머리글 행 고정
  sh.setFrozenRows(1);
  // 전체 열 너비 설정
  COL_WIDTHS.forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
  // 본문 영역 전체를 일반 텍스트 서식으로 (날짜 자동 변환 방지)
  sh.getRange(2, 1, sh.getMaxRows() - 1, TOTAL_COLS).setNumberFormat('@').setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP).setVerticalAlignment('top');
  // 가격영향 열(I)에 목록 선택 규칙 적용
  sh.getRange(2, 9, sh.getMaxRows() - 1, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(IMPACT_VALUES, true).setAllowInvalid(false).build());
  // 중요도 열(J)에 목록 선택 규칙 적용
  sh.getRange(2, 10, sh.getMaxRows() - 1, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(IMPORTANCE_VALUES, true).setAllowInvalid(false).build());
  return sh;
}

// ---------------------------------------------------------------------
// 날짜·문자 도구
// ---------------------------------------------------------------------
// 오늘 날짜 (한국 시간, YYYY-MM-DD)
function today_() {
  return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
}

// 여러 형식의 날짜 값을 YYYY-MM-DD 문자열로 통일 (실패하면 빈 문자열)
function normDate_(v) {
  // 시트가 날짜로 바꿔 놓은 경우
  if (v instanceof Date) return Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
  // 문자열로 바꾸고 앞뒤 공백 제거
  const s = String(v == null ? '' : v).trim();
  // 2026-11-01, 2026.11.01, 2026/11/1 형식 허용
  const m = s.match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})/);
  // 맞지 않으면 빈 문자열
  if (!m) return '';
  // 월과 일을 두 자리로 맞춰 반환
  return m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
}

// 실제로 존재하는 날짜인지 검사 (예: 2026-02-30은 false)
function isValidDate_(s) {
  // 형식부터 검사
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) return false;
  // 연, 월, 일 분리
  const p = s.split('-').map(Number);
  // 같은 값으로 다시 만들어 보고 일치하는지 확인
  const d = new Date(p[0], p[1] - 1, p[2]);
  return d.getFullYear() === p[0] && d.getMonth() === p[1] - 1 && d.getDate() === p[2];
}

// 문자열 앞뒤 공백을 지우고 최대 길이로 자름
function cut_(v, max) {
  return String(v == null ? '' : v).trim().slice(0, max);
}

// '제목||본문' 줄들을 [{head, body}] 배열로 변환 (|| 가 없으면 제목 없이 본문만)
function parsePairs_(text) {
  return String(text || '').split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean).map(function (line) {
    const i = line.indexOf('||');
    return i >= 0 ? { head: line.slice(0, i).trim(), body: line.slice(i + 2).trim() } : { head: '', body: line };
  });
}

// [{head, body}] 배열을 시트에 저장하는 줄 형식('제목||본문')으로 변환
function joinPairs_(list) {
  return list.map(function (p) { return p.head ? p.head + '||' + p.body : p.body; }).join('\n');
}

// 입력 항목(글자 또는 {head, body})을 정리해 [{head, body}] 로 통일
function normPairs_(arr) {
  const out = [];
  arr.forEach(function (item) {
    let head = '', body = '';
    if (item && typeof item === 'object') {
      head = cut_(item.head, 200);
      body = cut_(item.body, 1500);
    } else {
      // 글자일 때는 앞의 목록 기호(-, •, 번호)를 지우고 '||' 로 제목과 본문을 나눔
      const line = String(item == null ? '' : item).replace(/^\s*(?:[-•·*]|\d+[.)])\s*/, '').trim();
      const i = line.indexOf('||');
      head = i >= 0 ? cut_(line.slice(0, i), 200) : '';
      body = cut_(i >= 0 ? line.slice(i + 2) : line, 1500);
    }
    // 제목이나 본문 중 하나라도 있으면 담음
    if (head || body) out.push({ head: head, body: body });
  });
  return out;
}

// 본문을 빈 줄 기준으로 문단 배열로 나눔
function splitParagraphs_(text) {
  return String(text || '').split(/\n\s*\n/).map(function (s) { return s.trim(); }).filter(Boolean);
}

// ---------------------------------------------------------------------
// 캐시 도구 (버전 번호가 바뀌면 이전 캐시는 모두 무효)
// ---------------------------------------------------------------------
// 현재 캐시 버전
function cacheVer_() {
  return PropertiesService.getScriptProperties().getProperty('CACHE_VER') || '1';
}

// 캐시 버전을 1 올려 모든 캐시를 무효화
function bumpCacheVer_() {
  const props = PropertiesService.getScriptProperties();
  props.setProperty('CACHE_VER', String(Number(props.getProperty('CACHE_VER') || '1') + 1));
}

// 캐시 키 앞에 버전을 붙임
function ck_(name) {
  return 'v' + cacheVer_() + ':' + name;
}

// 캐시에서 읽기 (없거나 오류면 null)
function cacheGet_(key) {
  try {
    const v = CacheService.getScriptCache().get(key);
    return v ? JSON.parse(v) : null;
  } catch (e) {
    return null;
  }
}

// 캐시에 저장 (캐시 한도 100KB를 넘으면 건너뜀)
function cachePut_(key, obj, ttl) {
  try {
    const s = JSON.stringify(obj);
    if (Utilities.newBlob(s).getBytes().length < 95000) CacheService.getScriptCache().put(key, s, ttl);
  } catch (e) {
    // 캐시 실패는 기능에 영향이 없으므로 무시
  }
}

// ---------------------------------------------------------------------
// 관리용 함수 (편집기에서 직접 실행하거나 시트 메뉴로 실행)
// ---------------------------------------------------------------------
// 시트를 열 때 '뉴스 앱' 메뉴 추가 (시트에 연결된 스크립트일 때만 동작)
function onOpen() {
  try {
    SpreadsheetApp.getUi().createMenu('뉴스 앱').addItem('캐시 비우기', 'clearCache').addToUi();
  } catch (e) {
    // 시트에 연결되지 않은 스크립트면 메뉴를 만들지 않음
  }
}

// 캐시 비우기: 시트를 직접 고친 뒤 화면에 바로 반영하고 싶을 때 실행
function clearCache() {
  bumpCacheVer_();
  console.log('캐시를 비웠습니다.');
}

// 설치 점검: 처음 한 번 실행해서 권한을 승인하고 연결 상태를 확인
function checkSetup() {
  // 시트 열기 (이때 권한 승인 창이 뜸)
  const ss = openSs_();
  // 월 탭 목록
  const tabs = monthSheets_(ss).map(function (s) { return s.getName(); });
  // 등록 키 설정 여부
  const hasKey = !!PropertiesService.getScriptProperties().getProperty('REGISTER_KEY');
  // 결과를 실행 로그에 출력
  console.log('시트 이름: ' + ss.getName());
  console.log('월 탭: ' + tabs.join(', '));
  console.log('날짜 목록: ' + JSON.stringify(getDates_().dates));
  console.log('등록 키 설정: ' + (hasKey ? '완료' : '아직 없음 (프로젝트 설정 > 스크립트 속성에 REGISTER_KEY 추가)'));
}
// T stores ingestion fingerprints. Deleted records retain their original row and ID.
function articleKey_(url) {
  const s = String(url || '').trim();
  const id = s.match(/[?&]articleID=([\w-]+)/i) || s.match(/news-article-([\w-]+)/i);
  if (id) return (s.match(/spglobal\.com/i) ? 'platts:' : 'icis:') + id[1].toLowerCase();
  return s.replace(/([?&])(utm_[^=&]+|ref|tracking)=[^&#]*/gi, '$1').replace(/[?&]+$/, '').replace(/\/$/, '');
}
function publisher_(value) {
  const s=String(value||'').trim().toLowerCase();
  if (/platts|플래츠|플랫츠|s\s*&\s*p global/.test(s)) return 'platts';
  if (/icis|아이시스/.test(s)) return 'icis';
  return s === '기타 매체' ? '' : s;
}
function newsLead_(text,title) {
  const lines=String(text||'').normalize('NFKC').replace(/\r/g,'').split('\n');
  while(lines.length && (!lines[0].trim() || lines[0].trim()===String(title||'').trim() ||
    /^(?:by\s+|(?:author|published|updated|source)\s*:|\d{4}-\d{2}-\d{2}(?:\s|$))/i.test(lines[0].trim()))) lines.shift();
  const normalized=lines.join(' ').replace(/[“”]/g,'"').replace(/[‘’]/g,"'").replace(/\s+/g,' ').trim();
  for (const m of normalized.matchAll(/[.!?]["')\]]*(?=\s|$)/g)) {
    const prefix=normalized.slice(0,m.index+1);
    if (/\b(?:U\.S|U\.K|e\.g|i\.e|Mr|Mrs|Dr|Inc|Ltd|St|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\.$/i.test(prefix) && m.index+m[0].length<normalized.length) continue;
    return normalized.slice(0,m.index+m[0].length).trim().toLowerCase();
  }
  return normalized.slice(0,4000).toLowerCase();
}
function sameLead_(r,a,lead) {
  const publisher=publisher_(a.source);
  return Boolean(lead && publisher && r.meta.lead===lead && r.a.date===a.date && publisher_(r.a.source)===publisher);
}


function newsRecords_(ss, date) {
  const list = [];
  monthSheets_(ss).forEach(function(sh) {
    if (sh.getLastRow() < 2) return;
    const n = sh.getLastRow()-1;
    const rows = sh.getRange(2, 1, n, LIGHT_COLS).getValues();
    const metadata = sh.getMaxColumns() >= 20 ? sh.getRange(2,20,n,1).getValues() : [];
    const needLegacy = date && rows.some((row,i)=>normDate_(row[1])===date && !metadata[i]?.[0]);
    const originals=needLegacy ? sh.getRange(2,15,n,2).getValues() : [];
    rows.forEach(function(row, i) {
      const article = rowToLight_(row);
      if (!article.id) return;
      const meta = JSON.parse(metadata[i] && metadata[i][0] || '{}');
      if (!meta.lead && article.date===date && originals[i]) meta.lead=newsLead_(String(originals[i][0]||"")+String(originals[i][1]||""),article.titleEn);
      list.push({sh:sh, row:i+2, a:article, meta:meta, removed:article.id.startsWith('trash:')});
    });
  });
  return list;
}
function sameNews_(r, a, hash) {
  const key = articleKey_(a.url);
  return (key && (articleKey_(r.a.url) === key || (r.meta.aliases || []).indexOf(key)>=0)) ||
    (hash && r.meta.hash === hash) ||
    (r.a.date === a.date && r.a.titleEn && a.titleEn && r.a.titleEn.toLowerCase().trim() === a.titleEn.toLowerCase().trim() && r.a.source.split(' ')[0] === a.source.split(' ')[0]);
}
function newsAdmin_(b) {
  const invalid = checkKey_(b.key);
  if (invalid) return invalid;
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const records = newsRecords_(openSs_(),b.article?.date);
    if (b.action === 'trashList') return {ok:true,items:records.filter(r=>r.removed).map(r=>({id:r.a.id.slice(6),title:r.a.titleKo}))};
    if (b.action === 'lookup') {
      const lead=newsLead_(b.article.leadText,b.article.titleEn);
      const hit = records.find(r=>sameNews_(r,b.article,b.hash) || sameLead_(r,b.article,lead));
      if (!hit) return {ok:true,state:'new'};
      if (!hit.meta.lead && lead && hit.meta.hash===b.hash){
        hit.meta.lead=lead;
        hit.sh.getRange(hit.row,20).setValue(JSON.stringify(hit.meta));
      }
      const alias = articleKey_(b.article.url);
      if (!hit.removed && hit.meta.hash === b.hash && alias && !(hit.meta.aliases||[]).includes(alias)) {
        hit.meta.aliases = (hit.meta.aliases||[]).concat(alias);
        hit.sh.getRange(hit.row,20).setValue(JSON.stringify(hit.meta));
      }
      return {ok:true,id:hit.a.id,state:hit.removed?'deleted':sameLead_(hit,b.article,lead)||!hit.meta.hash||hit.meta.hash===b.hash?'existing':'changed'};
    }
    const restore = b.action === 'restore';
    if (!/^\d{8}-\d{3,}$/.test(b.id)) return fail_('기사 번호 확인 필요','BAD_ID');
    const hit = records.find(r=>r.a.id === (restore?'trash:':'')+b.id);
    if (!hit) return fail_('기사를 찾을 수 없습니다.','NOT_FOUND');
    hit.sh.getRange(hit.row,1).setValue((restore?'':'trash:')+b.id);
    SpreadsheetApp.flush();
    bumpCacheVer_();
    return {ok:true,id:b.id,date:hit.a.date};
  } finally { lock.releaseLock(); }
}
