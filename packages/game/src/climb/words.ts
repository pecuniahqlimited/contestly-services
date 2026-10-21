/**
 * The word list scramble draws from and word hunt accepts. Plain, common words a Nigerian player knows,
 * lowercase, 3–8 letters. A word hunt answer counts only if it's on this list.
 */
export const WORDS: readonly string[] = [
  "ace", "act", "age", "aim", "air", "arm", "art", "bag", "ball", "band", "bank", "beat", "bell", "bird", "boat", "body", "bold", "bone", "book", "boss",
  "bread", "brick", "bus", "cake", "call", "camp", "card", "care", "cash", "cat", "chair", "chief", "city", "class", "clock", "cloud", "coat", "cook", "corn", "cup",
  "dance", "dark", "date", "day", "deal", "desk", "dog", "door", "dream", "drum", "dust", "ear", "earth", "egg", "eye", "face", "fair", "farm", "fast", "fish",
  "flag", "food", "foot", "fork", "fruit", "game", "gate", "gift", "goal", "gold", "grass", "green", "hand", "hat", "head", "heart", "home", "horse", "house", "ice",
  "idea", "iron", "jam", "job", "joke", "juice", "key", "king", "kite", "lake", "lamp", "land", "leaf", "lion", "lip", "love", "map", "market", "meat", "milk",
  "money", "moon", "music", "name", "net", "night", "nose", "note", "oil", "orange", "owl", "page", "palm", "paper", "party", "pen", "phone", "pot", "queen", "radio",
  "rain", "rice", "ring", "river", "road", "rock", "roof", "room", "rose", "salt", "sand", "school", "sea", "seat", "ship", "shoe", "shop", "sky", "smile", "song",
  "star", "stone", "story", "street", "sun", "table", "taxi", "tea", "team", "time", "tree", "train", "water", "wind", "yam", "yard", "zebra", "jollof", "danfo", "okada",
  "suya", "agege", "garri", "kente", "plantain", "lagos", "kano", "abuja", "naira", "pepper", "goat", "mango", "guava", "lemon", "cocoa", "bean", "soup", "stew",
];
export const WORD_SET: ReadonlySet<string> = new Set(WORDS);
