CREATE TABLE "climb_words" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"word" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"games" text[] NOT NULL,
	"theme" text,
	"added_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "climb_words_word_unique" UNIQUE("word")
);
--> statement-breakpoint
ALTER TABLE "climb_words" ADD CONSTRAINT "climb_words_added_by_user_id_users_id_fk" FOREIGN KEY ("added_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "climb_words_active_idx" ON "climb_words" USING btree ("active");--> statement-breakpoint
-- The starter list, for every word game: everyday English words, at least 40 of each length from 4 to 8 so the default
-- ladder never runs short, plus a small "nigeria" theme (food, places, everyday life). Admins edit it from here on.
INSERT INTO "climb_words" ("word", "games", "theme")
SELECT v.word, ARRAY['scramble', 'word_search', 'word_hunt'], NULL
FROM (VALUES
  ('ace'), ('act'), ('adventure'), ('age'), ('aim'), ('air'), ('aircraft'), ('alphabet'), ('animal'), ('apple'), ('arm'), ('art'),
  ('backyard'), ('bag'), ('ball'), ('balloon'), ('banana'), ('band'), ('bank'), ('basket'), ('bat'), ('bath'), ('bathroom'), ('beach'),
  ('bean'), ('beat'), ('beautiful'), ('bed'), ('bee'), ('bell'), ('bench'), ('bicycle'), ('bike'), ('bird'), ('birthday'), ('blanket'),
  ('blessing'), ('boat'), ('body'), ('bold'), ('bone'), ('book'), ('boss'), ('bottle'), ('bowl'), ('box'), ('boy'), ('bread'),
  ('brick'), ('bridge'), ('brush'), ('bucket'), ('building'), ('bus'), ('butter'), ('butterfly'), ('button'), ('cabbage'), ('cake'), ('calendar'),
  ('call'), ('camera'), ('camp'), ('campfire'), ('candle'), ('cap'), ('captain'), ('car'), ('card'), ('care'), ('carpenter'), ('carpet'),
  ('cart'), ('cash'), ('castle'), ('cat'), ('cave'), ('celebrate'), ('chair'), ('chalk'), ('cheese'), ('chest'), ('chicken'), ('chief'),
  ('child'), ('children'), ('chocolate'), ('church'), ('circle'), ('city'), ('class'), ('classroom'), ('clean'), ('climate'), ('clock'), ('cloud'),
  ('coat'), ('cocoa'), ('coffee'), ('coin'), ('college'), ('compass'), ('computer'), ('concert'), ('cook'), ('corn'), ('cotton'), ('cousin'),
  ('cow'), ('crocodile'), ('crowd'), ('cup'), ('cupboard'), ('cushion'), ('dance'), ('dark'), ('date'), ('daughter'), ('day'), ('deal'),
  ('desk'), ('detective'), ('diamond'), ('dinosaur'), ('dish'), ('doctor'), ('dog'), ('dolphin'), ('door'), ('drawing'), ('dream'), ('drink'),
  ('drum'), ('duck'), ('dust'), ('ear'), ('earth'), ('egg'), ('elephant'), ('envelope'), ('example'), ('exercise'), ('eye'), ('face'),
  ('factory'), ('fair'), ('family'), ('fan'), ('farm'), ('farmland'), ('fast'), ('father'), ('feather'), ('festival'), ('field'), ('fireworks'),
  ('fish'), ('fishing'), ('flag'), ('flour'), ('flower'), ('food'), ('foot'), ('football'), ('forest'), ('fork'), ('fox'), ('freedom'),
  ('friend'), ('friendly'), ('fruit'), ('furniture'), ('gallery'), ('game'), ('garden'), ('gate'), ('gift'), ('ginger'), ('giraffe'), ('glass'),
  ('goal'), ('goalpost'), ('goat'), ('gold'), ('grass'), ('green'), ('guava'), ('guitar'), ('gum'), ('hall'), ('hammer'), ('hand'),
  ('happiness'), ('harvest'), ('hat'), ('head'), ('headline'), ('heart'), ('hen'), ('hill'), ('holiday'), ('home'), ('hometown'), ('homework'),
  ('horn'), ('horse'), ('hospital'), ('hot'), ('house'), ('ice'), ('idea'), ('ink'), ('iron'), ('island'), ('jacket'), ('jam'),
  ('jar'), ('job'), ('joke'), ('journey'), ('juice'), ('kangaroo'), ('kente'), ('kettle'), ('key'), ('keyboard'), ('kid'), ('king'),
  ('kingdom'), ('kitchen'), ('kite'), ('kitten'), ('knife'), ('ladder'), ('lake'), ('lamp'), ('land'), ('language'), ('lantern'), ('laugh'),
  ('laundry'), ('leaf'), ('leg'), ('lemon'), ('letter'), ('library'), ('light'), ('lion'), ('lip'), ('lock'), ('love'), ('machine'),
  ('magazine'), ('mango'), ('map'), ('market'), ('marriage'), ('mat'), ('meal'), ('meat'), ('medicine'), ('melon'), ('milk'), ('mirror'),
  ('money'), ('monkey'), ('moon'), ('moonlight'), ('morning'), ('mother'), ('mountain'), ('mouth'), ('music'), ('musician'), ('nail'), ('name'),
  ('necklace'), ('needle'), ('nest'), ('net'), ('network'), ('newspaper'), ('night'), ('nose'), ('note'), ('notebook'), ('nut'), ('ocean'),
  ('octopus'), ('oil'), ('onion'), ('orange'), ('ornament'), ('owl'), ('page'), ('paint'), ('painter'), ('painting'), ('palm'), ('pan'),
  ('pancake'), ('paper'), ('park'), ('parrot'), ('party'), ('peace'), ('peacock'), ('pear'), ('pen'), ('pencil'), ('pepper'), ('pharmacy'),
  ('phone'), ('piano'), ('picture'), ('pig'), ('pillow'), ('pineapple'), ('pipe'), ('plan'), ('planet'), ('plant'), ('plantain'), ('plastic'),
  ('plate'), ('platform'), ('pocket'), ('pool'), ('pot'), ('princess'), ('pumpkin'), ('puzzle'), ('pyramid'), ('queen'), ('question'), ('rabbit'),
  ('radio'), ('rain'), ('rainbow'), ('rainfall'), ('rat'), ('reading'), ('red'), ('rice'), ('ring'), ('river'), ('road'), ('robot'),
  ('rock'), ('roof'), ('room'), ('rope'), ('rose'), ('salad'), ('salt'), ('sand'), ('sandwich'), ('school'), ('science'), ('scissors'),
  ('sea'), ('seat'), ('sheep'), ('shelter'), ('ship'), ('shirt'), ('shoe'), ('shop'), ('shopping'), ('silk'), ('singer'), ('sister'),
  ('sky'), ('slippers'), ('smile'), ('snake'), ('snow'), ('soap'), ('sock'), ('soldier'), ('song'), ('sound'), ('soup'), ('spider'),
  ('spoon'), ('star'), ('station'), ('step'), ('stew'), ('stone'), ('storm'), ('story'), ('street'), ('sugar'), ('summer'), ('sun'),
  ('sunlight'), ('sunrise'), ('sunshine'), ('sweet'), ('swimming'), ('table'), ('taxi'), ('tea'), ('teacher'), ('team'), ('telephone'), ('tent'),
  ('thunder'), ('ticket'), ('tiger'), ('time'), ('toe'), ('tomato'), ('tool'), ('top'), ('tortoise'), ('towel'), ('town'), ('toy'),
  ('traffic'), ('train'), ('travel'), ('treasure'), ('tree'), ('triangle'), ('turtle'), ('umbrella'), ('uniform'), ('universe'), ('vacation'), ('van'),
  ('vegetable'), ('village'), ('wall'), ('wardrobe'), ('water'), ('wave'), ('weather'), ('web'), ('wedding'), ('wheel'), ('whistle'), ('wind'),
  ('window'), ('wing'), ('winter'), ('wood'), ('world'), ('writing'), ('yam'), ('yard'), ('yellow'), ('zebra')
) AS v(word)
ON CONFLICT ("word") DO NOTHING;
--> statement-breakpoint
INSERT INTO "climb_words" ("word", "games", "theme")
SELECT v.word, ARRAY['scramble', 'word_search', 'word_hunt'], 'nigeria'
FROM (VALUES
  ('abuja'), ('agbada'), ('agege'), ('akara'), ('amala'), ('ankara'), ('buba'), ('buka'), ('calabar'), ('danfo'), ('dodo'), ('eba'),
  ('egusi'), ('enugu'), ('fufu'), ('garri'), ('gele'), ('ibadan'), ('ikeja'), ('ilorin'), ('jollof'), ('jos'), ('kaduna'), ('kano'),
  ('keke'), ('kobo'), ('kolanut'), ('kunu'), ('lagos'), ('naira'), ('ogbono'), ('okada'), ('onitsha'), ('owerri'), ('sokoto'), ('suya'),
  ('wahala'), ('warri'), ('yaba'), ('zaria'), ('zobo')
) AS v(word)
ON CONFLICT ("word") DO NOTHING;
