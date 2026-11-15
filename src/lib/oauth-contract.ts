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

/** 生物辨識意圖（authorize 的 biometric_intent、intent 端點的 body、導回網址的旗標值）。 */
export const BIOMETRIC_INTENTS = ['enable', 'disable'] as const;
export type BiometricIntent = (typeof BIOMETRIC_INTENTS)[number];
export const isBiometricIntent = (v: unknown): v is BiometricIntent => (BIOMETRIC_INTENTS as readonly unknown[]).includes(v);

/** web 授權頁網址的 reauth 值：兩種意圖，加上單獨 prompt=login 的 'login'。 */
export const REAUTH_LOGIN = 'login' as const;
export const REAUTH_MODES = [...BIOMETRIC_INTENTS, REAUTH_LOGIN] as const;
export type ReauthMode = (typeof REAUTH_MODES)[number];

/** 導回 App 的 error 值（也當作稽核的 failureReason）。 */
export const REAUTH_ACCOUNT_MISMATCH = 'reauth_account_mismatch' as const;

/** 網址 query 的旗標名稱。 */
export const PARAM_BIOMETRIC_HINT = 'biometric_hint' as const;
export const PARAM_BIOMETRIC_INTENT = 'biometric_intent' as const;
export const PARAM_REAUTH = 'reauth' as const;

/**
 * 登入碼（/api/oauth/login 簽發）的兩個約定，重新驗證的「剛用密碼登入」檢查依賴它們：
 * 1. TTL：登入碼換成 token 後仍留在 oauth_models 到期，新鮮度視窗就是這個秒數。
 * 2. redirect_uri 為 null：第一方直接換 code、沒有跳轉；一般授權碼一定有 redirect_uri，靠它區分兩者。
 */
export const LOGIN_CODE_TTL_SEC = 60;
export const LOGIN_CODE_REDIRECT_URI = null;
