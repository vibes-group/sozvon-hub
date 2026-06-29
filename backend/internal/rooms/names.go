package rooms

import (
	"crypto/rand"
	"fmt"
	"math/big"
)

// Adjectives and nouns are both masculine so "{adj}-{noun}" always agrees in
// gender — the generated name reads naturally without per-word logic.
var nameAdjectives = []string{
	"быстрый", "синий", "тихий", "яркий", "хитрый", "смелый", "лёгкий", "добрый",
	"звёздный", "снежный", "ночной", "лесной", "морской", "огненный", "весёлый", "мудрый",
}

var nameNouns = []string{
	"тигр", "сокол", "барс", "филин", "ёж", "лис", "кит", "волк",
	"бобр", "енот", "грифон", "дельфин", "пингвин", "хорёк", "беркут", "морж",
}

// generateName builds a friendly, human-readable room name like "синий-тигр-42".
// Used when the creator leaves the name blank.
func generateName() string {
	return fmt.Sprintf("%s-%s-%d",
		nameAdjectives[randIndex(len(nameAdjectives))],
		nameNouns[randIndex(len(nameNouns))],
		randIndex(90)+10, // 10..99
	)
}

func randIndex(n int) int {
	if n <= 0 {
		return 0
	}
	v, err := rand.Int(rand.Reader, big.NewInt(int64(n)))
	if err != nil {
		return 0
	}
	return int(v.Int64())
}
