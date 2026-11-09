/**
 * 구글 시트 기록 (두 사이트가 같이 써요)
 *  - 경비 검수 에이전트 → '검수 기록' 탭
 *  - fixdesk 하자 접수   → '하자 접수' 탭
 *  - 한잔로스터리 주문   → '주문' 탭, 문의 → '문의' 탭 (hanjan-shop)
 * 알림은 Slack으로 가요 (예전 Gmail 알림은 뺐어요).
 *
 * 설치·바꾸기 (사용자가 직접):
 * 1. 구글 시트 → [확장 프로그램] → [Apps Script]에 이 파일 내용을 전부 붙여 넣고 저장해요.
 * 2. [프로젝트 설정(톱니바퀴)] → [스크립트 속성] → 속성 'SECRET'(꼭 대문자), 값은 아무 긴 글자.
 * 3. [배포] → [배포 관리] → 연필(수정) → 버전 '새 버전' → 배포. (주소는 그대로 유지돼요)
 *    처음 배포라면 [새 배포] → 유형 '웹 앱' → 실행 사용자 '나', 액세스 '모든 사용자'.
 * 4. 웹 앱 URL과 SECRET 값을 Cloudflare 비밀값으로 넣어요 (각 사이트의 set-secrets.ps1).
 */

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return reply({ ok: false, error: 'bad json' });
  }
  const secret = PropertiesService.getScriptProperties().getProperty('SECRET');
  if (!secret || body.secret !== secret) {
    // 연결 문제를 찾기 쉽게 길이만 알려 줘요 (값 자체는 절대 돌려주지 않음)
    return reply({
      ok: false, error: 'unauthorized',
      has_secret_property: !!secret,
      property_length: secret ? secret.length : 0,
      received_length: body.secret ? String(body.secret).length : 0,
    });
  }
  if (body.action === 'ping') return reply({ ok: true, pong: true });

  if (body.action === 'append') return reply(appendRow(body.row));
  if (body.action === 'fixdesk') return reply(appendTicket(body.row));
  if (body.action === 'shop_order') return reply(appendOrder(body.row));
  if (body.action === 'shop_inquiry') return reply(appendShopInquiry(body.row));
  return reply({ ok: false, error: 'unknown action' });
}

function appendRow(r) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('검수 기록') ||
    SpreadsheetApp.getActiveSpreadsheet().insertSheet('검수 기록');
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['번호', '기록 시각', '판정', '문서', '종류', '청구자', '팀', '업체·가맹점', '금액', '요약', '문제와 근거 조항', '상세 보기']);
    sheet.setFrozenRows(1);
  } else if (sheet.getRange(1, 12).getValue() === '') {
    sheet.getRange(1, 12).setValue('상세 보기'); // 예전에 만든 시트에도 칸 제목 추가
  }
  // 상세 보기: 에이전트 화면에서 그 검수의 근거 원문·단계·알림을 바로 열어요 (주소는 에이전트 사이트로만)
  const url = String(r.detail_url || '');
  const link = /^https:\/\/[a-z0-9.-]+\.workers\.dev\/\?id=\d+$/.test(url) ? '=HYPERLINK("' + url + '", "열기")' : '';
  sheet.appendRow([
    r.id, new Date(), r.verdict, r.doc_type, r.category, r.employee || '', r.team || '',
    r.vendor || '', r.amount || '', r.summary, r.issues || '', link,
  ]);
  return { ok: true };
}

// fixdesk 하자 접수: 접수될 때마다 한 줄 (고객 이름·전화번호는 가려서 받아요)
function appendTicket(r) {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = book.getSheetByName('하자 접수') || book.insertSheet('하자 접수');
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['접수 번호', '접수 시각', '급한 정도', '종류', '담당 팀', '요약', '주소', '고객', '판단 이유', '관리자 화면']);
    sheet.setFrozenRows(1);
  }
  const url = String(r.admin_url || '');
  const link = /^https:\/\/[a-z0-9.-]+\.workers\.dev\/admin\.html(#\d+)?$/.test(url) ? '=HYPERLINK("' + url + '", "열기")' : '';
  sheet.appendRow([
    r.id, new Date(), r.urgency || '', r.category || '', r.team || '', String(r.summary || '').slice(0, 300),
    String(r.address || '').slice(0, 120), r.customer || '', String(r.reason || '').slice(0, 300), link,
  ]);
  return { ok: true };
}

// 한잔로스터리(가상 원두 가게) 주문: 주문될 때마다 한 줄 (손님 이름·전화번호는 가려서 받아요)
function appendOrder(r) {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = book.getSheetByName('주문') || book.insertSheet('주문');
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['주문 번호', '주문 시각', '금액', '상품', '분쇄', '손님', '상태', '재구매 안내', '관리자 화면']);
    sheet.setFrozenRows(1);
  }
  const url = String(r.admin_url || '');
  const link = /^https:\/\/[a-z0-9.-]+\.workers\.dev\/admin\.html(#order-\d+)?$/.test(url) ? '=HYPERLINK("' + url + '", "열기")' : '';
  sheet.appendRow([
    r.id, new Date(), Number(r.total) || 0, String(r.items || '').slice(0, 300), r.grind || '',
    r.customer || '', r.status || '', r.reorder || '', link,
  ]);
  return { ok: true };
}

// 한잔로스터리 문의: 문의마다 한 줄 (손님 원문은 보내지 않고 AI 요약만, 이름은 가려서)
function appendShopInquiry(r) {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = book.getSheetByName('문의') || book.insertSheet('문의');
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['문의 번호', '접수 시각', '급한 정도', '종류', '요약', '손님', '주문 번호', '사람 판단', '근거 안내문', '관리자 화면']);
    sheet.setFrozenRows(1);
  }
  const url = String(r.admin_url || '');
  const link = /^https:\/\/[a-z0-9.-]+\.workers\.dev\/admin\.html(#inquiry-\d+)?$/.test(url) ? '=HYPERLINK("' + url + '", "열기")' : '';
  sheet.appendRow([
    r.id, new Date(), r.urgency || '', r.category || '', String(r.summary || '').slice(0, 300),
    r.customer || '', r.order_id || '', r.needs_human || '', r.cited || '', link,
  ]);
  return { ok: true };
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
