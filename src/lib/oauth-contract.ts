/**
 * 授權協定的單一出處：App、web、api 之間約定的白名單值、導回網址的 error 與旗標名稱，
 * 以及「登入碼」的兩個隱性約定。authorize、authorize-requests、login、OpenAPI schema 一律引用這裡，
 * 新增驗證方式或改 TTL 只改這個檔，其餘寫死的地方會在 typecheck 或測試報錯。
 */

/** App 發起授權時帶的 biometric_hint；其他值當作沒帶。 */
export const BIOMETRIC_HINTS = ['faceid', 'touchid', 'generic'] as const;
export type BiometricHint = (typeof BIOMETRIC_HINTS)[number];
export const isBiometricHint = (v: unknown): v is BiometricHint => (BIOMETRIC_HINTS as readonly unknown[]).includes(v);

/** GET requests/:id 回給 web 的 hint：只有會改按鈕名稱的值（generic 對外為 null）。 */
export const BIOMETRIC_BUTTON_HINTS = ['faceid', 'touchid'] as const satisfies readonly BiometricHint[];
export type BiometricButtonHint = (typeof BIOMETRIC_BUTTON_HINTS)[number];
export const isBiometricButtonHint = (v: unknown): v is BiometricButtonHint => (BIOMETRIC_BUTTON_HINTS as readonly unknown[]).includes(v);

/** 生物辨識意圖（intent 端點的 body、導回網址的旗標值）。只有 web 登入頁按鈕的 enable；重新驗證模式已移除（ADR-0019）。 */
export const BIOMETRIC_INTENTS = ['enable'] as const;
export type BiometricIntent = (typeof BIOMETRIC_INTENTS)[number];
export const isBiometricIntent = (v: unknown): v is BiometricIntent => (BIOMETRIC_INTENTS as readonly unknown[]).includes(v);

/** App 目前顯示的明暗（授權端點轉傳給 web 授權頁；其他值、重複參數一律丟棄）。 */
export const THEMES = ['light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];
export const isTheme = (v: unknown): v is Theme => (THEMES as readonly unknown[]).includes(v);

/** 網址 query 的旗標名稱。 */
export const PARAM_BIOMETRIC_HINT = 'biometric_hint' as const;
export const PARAM_BIOMETRIC_INTENT = 'biometric_intent' as const;
export const PARAM_THEME = 'theme' as const;

/** 登入碼（/api/oauth/login 簽發，第一方直接換 token）的有效秒數。 */
export const LOGIN_CODE_TTL_SEC = 60;
