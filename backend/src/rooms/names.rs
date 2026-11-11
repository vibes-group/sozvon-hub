//! Friendly room names. They evoke a place — a deliberately different theme
//! from guest display names (animal personas), so a room and a person never
//! read alike. Adjectives and nouns are all feminine so "{adj} {noun}" agrees.

use crate::util::random_u32;

const ADJECTIVES: &[&str] = &[
    "Звёздная",
    "Туманная",
    "Янтарная",
    "Вечерняя",
    "Северная",
    "Дальняя",
    "Тёплая",
    "Зелёная",
    "Светлая",
    "Хрустальная",
    "Заветная",
    "Облачная",
    "Парусная",
    "Морская",
    "Песчаная",
    "Кедровая",
    "Сиреневая",
    "Закатная",
];

const NOUNS: &[&str] = &[
    "гавань",
    "бухта",
    "веранда",
    "студия",
    "мансарда",
    "оранжерея",
    "беседка",
    "терраса",
    "лагуна",
    "опушка",
    "поляна",
    "палуба",
    "башня",
    "пристань",
    "галерея",
    "мастерская",
    "гостиная",
    "аллея",
    "дюна",
    "обсерватория",
];

fn pick(words: &[&'static str]) -> &'static str {
    words[random_u32() as usize % words.len()]
}

/// Like "Звёздная гавань"; used when the creator leaves the name blank. The
/// slug is the unique handle, so an occasional duplicate name is harmless.
pub fn generate_name() -> String {
    format!("{} {}", pick(ADJECTIVES), pick(NOUNS))
}
