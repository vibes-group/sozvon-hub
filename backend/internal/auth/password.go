package auth

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"

	"golang.org/x/crypto/argon2"
)

type PasswordParams struct {
	MemoryKiB   uint32
	Iterations  uint32
	Parallelism uint8
	SaltBytes   uint32
	KeyBytes    uint32
}

func DefaultPasswordParams() PasswordParams {
	return PasswordParams{
		MemoryKiB:   32 * 1024,
		Iterations:  3,
		Parallelism: 1,
		SaltBytes:   16,
		KeyBytes:    32,
	}
}

func HashPassword(password string, params PasswordParams) (string, error) {
	salt := make([]byte, params.SaltBytes)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("generate salt: %w", err)
	}

	hash := argon2.IDKey(
		[]byte(password),
		salt,
		params.Iterations,
		params.MemoryKiB,
		params.Parallelism,
		params.KeyBytes,
	)

	return fmt.Sprintf(
		"$argon2id$v=19$m=%d,t=%d,p=%d$%s$%s",
		params.MemoryKiB,
		params.Iterations,
		params.Parallelism,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(hash),
	), nil
}

func VerifyPassword(password, encodedHash string) (bool, error) {
	params, salt, expectedHash, err := decodeHash(encodedHash)
	if err != nil {
		return false, err
	}

	actualHash := argon2.IDKey(
		[]byte(password),
		salt,
		params.Iterations,
		params.MemoryKiB,
		params.Parallelism,
		uint32(len(expectedHash)),
	)

	return subtle.ConstantTimeCompare(actualHash, expectedHash) == 1, nil
}

func decodeHash(encodedHash string) (PasswordParams, []byte, []byte, error) {
	parts := strings.Split(encodedHash, "$")
	if len(parts) != 6 || parts[1] != "argon2id" || parts[2] != "v=19" {
		return PasswordParams{}, nil, nil, errors.New("invalid password hash")
	}

	paramParts := strings.Split(parts[3], ",")
	if len(paramParts) != 3 {
		return PasswordParams{}, nil, nil, errors.New("invalid password hash params")
	}

	params := PasswordParams{}
	for _, part := range paramParts {
		keyValue := strings.SplitN(part, "=", 2)
		if len(keyValue) != 2 {
			return PasswordParams{}, nil, nil, errors.New("invalid password hash param")
		}

		value, err := strconv.ParseUint(keyValue[1], 10, 32)
		if err != nil {
			return PasswordParams{}, nil, nil, errors.New("invalid password hash param value")
		}

		switch keyValue[0] {
		case "m":
			params.MemoryKiB = uint32(value)
		case "t":
			params.Iterations = uint32(value)
		case "p":
			if value > math.MaxUint8 {
				return PasswordParams{}, nil, nil, errors.New("invalid password hash param value")
			}
			params.Parallelism = uint8(value)
		default:
			return PasswordParams{}, nil, nil, errors.New("unknown password hash param")
		}
	}

	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil {
		return PasswordParams{}, nil, nil, errors.New("invalid password hash salt")
	}

	hash, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil {
		return PasswordParams{}, nil, nil, errors.New("invalid password hash value")
	}

	return params, salt, hash, nil
}
