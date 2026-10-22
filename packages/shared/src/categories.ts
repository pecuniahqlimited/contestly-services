/** Lanes: the categories a party is tagged with and a player picks as interests. */
export const CATEGORIES = ["Afrobeats", "Football", "Nollywood", "General knowledge", "History", "Science", "Tech", "Fashion", "Food", "Geography", "Brain teasers", "Reality TV", "Maths", "Hip hop"] as const;
export type Category = (typeof CATEGORIES)[number];
