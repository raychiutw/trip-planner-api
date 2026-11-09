/**
 * AI 資料同意的「同意版本」與說明文字（spec #1553、ADR-0012）。
 *
 * - **版本內容不可變**：已發出的版本不得改寫文字；實質變更（處理方、資料類別、用途、保存或撤回方式）→ 新增版本、
 *   把 CURRENT_CONSENT_VERSION 指向它。錯字、排版、不影響使用者權利的措辭可原地修正，不升版。
 * - 文字放在程式碼裡，經 PR 審查；不放資料庫。web 與 Flutter 只顯示 server 回的這份。
 * - 責任人、聯絡信箱、處理方條款連結已由 owner 提供並填入（2026-11-09）。若日後再出現占位符（{{...}}），
 *   isConsentTextComplete() 會是 false，閘門就不會強制（見 ai-data-consent.ts）。
 *   閘門已無旗標（2026-11-09 owner 決定直接打開）：文案填妥即強制。
 */

export interface ConsentSection {
  heading: string;
  items: string[];
}

export interface ConsentText {
  version: string;
  title: string;
  intro: string;
  sections: ConsentSection[];
  /** 撤回的如實說明（單獨成段，UI 在撤回確認時也會用）。 */
  withdrawal: string[];
}

export const CURRENT_CONSENT_VERSION = 'ai-data-v1';

export const CONSENT_TEXTS: Record<string, ConsentText> = {
  'ai-data-v1': {
    version: 'ai-data-v1',
    title: '讓 AI 協助安排你的行程？',
    intro:
      'Tripline 的 AI 助理可以依你的要求，幫你查詢景點、調整行程順序、新增或修改行程內容。要做到這些，我們需要把部分資料交給 AI 處理。請先看清楚下面的內容，再決定要不要同意。',
    sections: [
      {
        heading: '我們會交給 AI 的資料',
        items: [
          '送出要求的人在聊天中輸入的文字，以及送出者的顯示名稱（不含 email）。',
          '被要求處理的那一個行程的內容：天數與日期、景點與店家名稱、備註、預約文字、交通方式與時間。',
          '不會交給 AI：密碼、登入憑證、帳號 email、其他行程。',
          '行程屬於它的擁有者：旅伴在這個行程送出的要求，也會把行程內容交給 AI 處理，旅伴不需要另外同意。',
        ],
      },
      {
        heading: '用途',
        items: ['只用來完成這一次提出的行程要求（查詢、新增、修改、重新排序）。'],
      },
      {
        heading: '處理方',
        items: [
          'Anthropic（Claude）。資料的保存期間與是否用於模型訓練，依處理方條款，詳見連結：https://www.anthropic.com/legal/commercial-terms',
          '另外使用 Google Maps 查詢景點資料；查詢內容只有景點名稱或地點識別碼，不包含個人資料。',
        ],
      },
      {
        heading: 'AI 可以做什麼、不能做什麼',
        items: ['AI 只能對被指定的那個行程新增、修改行程內容與景點資料，不能存取檔案、帳號設定或其他行程。每次修改都會留下紀錄。'],
      },
      {
        heading: '你的選擇',
        items: [
          '同意：你之後送出的 AI 要求會交給 AI 處理。',
          '不同意：不影響任何不需要 AI 的功能，仍可手動編輯行程、與旅伴共同編輯。',
          '隨時撤回：到「帳號設定 → AI 與資料」。',
        ],
      },
      {
        heading: '責任人與聯絡方式',
        items: ['責任人：邱淞瑋；聯絡信箱：lean.lean@gmail.com'],
      },
    ],
    withdrawal: [
      '撤回後，新的 AI 要求會立即被拒絕。',
      '排隊中、尚未開始的要求會被終結。',
      '已經開始的工作不保證能停止。',
      '已經交給 AI 處理的資料無法收回。',
    ],
  },
};

/** 占位符格式：{{大寫_底線}}。 */
export const PLACEHOLDER_PATTERN = /\{\{[A-Z0-9_]+\}\}/;
