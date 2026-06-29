package rooms

import "math/rand/v2"

// Room names evoke a place — a calm spot to gather — and use ambiance words, a
// deliberately different theme from guest display names (which are animal
// "personas" like "Хитрый Барсук"). So a room and a person never read alike.
// Adjectives and nouns are both feminine so "{adj} {noun}" always agrees in
// gender; only the adjective is capitalized, giving phrases like "Звёздная
// гавань".
var roomAdjectives = []string{
	"Звёздная", "Туманная", "Янтарная", "Вечерняя", "Северная", "Дальняя",
	"Тёплая", "Зелёная", "Светлая", "Хрустальная", "Заветная", "Облачная",
	"Парусная", "Морская", "Песчаная", "Кедровая", "Сиреневая", "Закатная",
}

var roomNouns = []string{
	"гавань", "бухта", "веранда", "студия", "мансарда", "оранжерея", "беседка",
	"терраса", "лагуна", "опушка", "поляна", "палуба", "башня", "пристань",
	"галерея", "мастерская", "гостиная", "аллея", "дюна", "обсерватория",
}

// generateName builds a friendly room name like "Звёздная гавань". Used when
// the creator leaves the name blank. The slug stays the unique handle, so an
// occasional duplicate name is harmless.
func generateName() string {
	return roomAdjectives[rand.IntN(len(roomAdjectives))] + " " + roomNouns[rand.IntN(len(roomNouns))]
}
