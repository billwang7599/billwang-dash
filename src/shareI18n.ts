/**
 * Interface text for the share-link page. The project's name and its tasks are content
 * and stay as written. English is the reference: every other language must have every key.
 */

export const LANGUAGES = {
    en: "English",
    "zh-Hans": "简体中文",
    "zh-Hant": "繁體中文",
    es: "Español",
    fr: "Français",
    ko: "한국어",
} as const;

export type Lang = keyof typeof LANGUAGES;

const en = {
    sharedBy: "Shared by {name}",
    todo: "To do",
    addPlaceholder: "Add a task…",
    addLabel: "Add a task",
    add: "Add",
    adding: "Adding…",
    complete: "Complete {task}",
    completed: "Completed {task}",
    viaLink: "via link",
    empty: "Nothing to do right now.",
    note: "Anyone with this link can add tasks and tick them off.",
    limit: "Daily limit reached. Try again tomorrow.",
    deadTitle: "This link is no longer active",
    deadBody: "Ask the person who sent it for a new one.",
    failed: "Something went wrong. Try again.",
    language: "Language",
};

export type Key = keyof typeof en;

const strings: Record<Lang, Record<Key, string>> = {
    en,
    "zh-Hans": {
        sharedBy: "由 {name} 分享",
        todo: "待办",
        addPlaceholder: "添加任务…",
        addLabel: "添加任务",
        add: "添加",
        adding: "添加中…",
        complete: "完成 {task}",
        completed: "已完成 {task}",
        viaLink: "来自链接",
        empty: "目前没有待办事项。",
        note: "任何拥有此链接的人都可以添加任务并将其勾选完成。",
        limit: "已达到每日上限，请明天再试。",
        deadTitle: "此链接已失效",
        deadBody: "请向发送链接的人索取新链接。",
        failed: "出错了，请重试。",
        language: "语言",
    },
    "zh-Hant": {
        sharedBy: "由 {name} 分享",
        todo: "待辦",
        addPlaceholder: "新增任務…",
        addLabel: "新增任務",
        add: "新增",
        adding: "新增中…",
        complete: "完成 {task}",
        completed: "已完成 {task}",
        viaLink: "來自連結",
        empty: "目前沒有待辦事項。",
        note: "任何擁有此連結的人都可以新增任務並將其勾選完成。",
        limit: "已達到每日上限，請明天再試。",
        deadTitle: "此連結已失效",
        deadBody: "請向傳送連結的人索取新連結。",
        failed: "發生錯誤，請再試一次。",
        language: "語言",
    },
    es: {
        sharedBy: "Compartido por {name}",
        todo: "Por hacer",
        addPlaceholder: "Añadir una tarea…",
        addLabel: "Añadir una tarea",
        add: "Añadir",
        adding: "Añadiendo…",
        complete: "Completar {task}",
        completed: "Completada: {task}",
        viaLink: "por enlace",
        empty: "No hay nada por hacer ahora mismo.",
        note: "Cualquiera con este enlace puede añadir tareas y marcarlas como hechas.",
        limit: "Se alcanzó el límite diario. Inténtalo de nuevo mañana.",
        deadTitle: "Este enlace ya no está activo",
        deadBody: "Pide un enlace nuevo a quien te lo envió.",
        failed: "Algo salió mal. Inténtalo de nuevo.",
        language: "Idioma",
    },
    fr: {
        sharedBy: "Partagé par {name}",
        todo: "À faire",
        addPlaceholder: "Ajouter une tâche…",
        addLabel: "Ajouter une tâche",
        add: "Ajouter",
        adding: "Ajout…",
        complete: "Terminer {task}",
        completed: "Terminée : {task}",
        viaLink: "via le lien",
        empty: "Rien à faire pour le moment.",
        note: "Toute personne disposant de ce lien peut ajouter des tâches et les cocher.",
        limit: "Limite quotidienne atteinte. Réessayez demain.",
        deadTitle: "Ce lien n'est plus actif",
        deadBody: "Demandez un nouveau lien à la personne qui vous l'a envoyé.",
        failed: "Une erreur s'est produite. Réessayez.",
        language: "Langue",
    },
    ko: {
        sharedBy: "{name}님이 공유함",
        todo: "할 일",
        addPlaceholder: "할 일 추가…",
        addLabel: "할 일 추가",
        add: "추가",
        adding: "추가 중…",
        complete: "{task} 완료",
        completed: "완료됨: {task}",
        viaLink: "링크로 추가됨",
        empty: "지금은 할 일이 없습니다.",
        note: "이 링크가 있는 사람은 누구나 할 일을 추가하고 완료 표시를 할 수 있습니다.",
        limit: "하루 한도에 도달했습니다. 내일 다시 시도해 주세요.",
        deadTitle: "이 링크는 더 이상 유효하지 않습니다",
        deadBody: "링크를 보낸 사람에게 새 링크를 요청하세요.",
        failed: "문제가 발생했습니다. 다시 시도해 주세요.",
        language: "언어",
    },
};

/** `text` in `lang`, with `{name}`-style holes filled from `vars`. */
export function translate(lang: Lang, key: Key, vars: Record<string, string> = {}): string {
    return strings[lang][key].replace(/\{(\w+)\}/g, (_, name: string) => vars[name] ?? "");
}

/** A BCP 47 tag ("fr", "zh-TW", "zh-Hant-HK") as one of ours, or null if we have no such language. */
export function matchLanguage(tag: string): Lang | null {
    const [base, ...rest] = tag.toLowerCase().split("-");
    if (base === "zh") {
        // Traditional for Taiwan, Hong Kong, Macau and an explicit Hant; Simplified otherwise.
        return rest.includes("hant") || rest.some((p) => ["tw", "hk", "mo"].includes(p)) ? "zh-Hant" : "zh-Hans";
    }
    return base in LANGUAGES ? (base as Lang) : null;
}

/** The best supported language for the browser's list, e.g. ["zh-TW", "en"] -> "zh-Hant". English if none fit. */
export function pickLanguage(preferred: readonly string[]): Lang {
    for (const tag of preferred) {
        const lang = matchLanguage(tag);
        if (lang) return lang;
    }
    return "en";
}

export const isLang = (value: string | null): value is Lang => value !== null && value in LANGUAGES;
