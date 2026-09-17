// ============================================================
// Утилиты общего назначения
// ============================================================

/**
 * Fisher-Yates shuffle. Возвращает НОВЫЙ массив, исходный не трогает.
 */
export function shuffle(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/**
 * Берёт n случайных элементов из массива (без повторов).
 */
export function pickRandom(arr, n) {
  if (n >= arr.length) return shuffle(arr);
  return shuffle(arr).slice(0, n);
}

/**
 * Генератор кода комнаты: 4 буквы, без I и O (чтобы не путать с 1 и 0).
 * Проверяет коллизии через переданный predicate.
 */
export function generateCode(isTaken = () => false, maxAttempts = 50) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const code = Array.from({ length: 4 }, () =>
      chars[Math.floor(Math.random() * chars.length)]
    ).join('');
    if (!isTaken(code)) return code;
  }
  throw new Error('Не удалось сгенерировать уникальный код комнаты');
}

/**
 * Безопасное имя: обрезает пробелы, ограничивает длину,
 * убирает управляющие символы.
 */
export function sanitizeName(name) {
  if (typeof name !== 'string') return '';
  return name
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .trim()
    .slice(0, 16);
}

/**
 * Обрезка строки с многоточием (для логов, не для UI).
 */
export function truncate(str, max = 40) {
  if (!str) return '';
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

/**
 * Проверка: является ли массив массивом уникальных строк.
 */
export function isUniqueStringArray(arr, { min = 0, max = Infinity } = {}) {
  if (!Array.isArray(arr)) return false;
  if (arr.length < min || arr.length > max) return false;
  if (!arr.every(x => typeof x === 'string' && x.length > 0)) return false;
  return new Set(arr).size === arr.length;
}

/**
 * Лог с префиксом и временем. Единый формат для сервера.
 */
export function log(tag, ...args) {
  const t = new Date().toISOString().slice(11, 19);
  console.log(`[${t}] [${tag}]`, ...args);
}

import { randomUUID } from 'node:crypto';

export function generateToken() {
  return randomUUID();
}