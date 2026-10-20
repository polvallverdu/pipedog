// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause

/** Hand-written parity corpus: [language, text]. */
export const CORPUS: ReadonlyArray<readonly [string, string]> = [
  // Abbreviations
  ["en", "Dr. Smith met Mr. Jones at noon. They talked for hours."],
  ["en", "Mrs. Brown and Ms. White work at Acme Inc. in the city."],
  ["en", "Bring fruit, e.g. apples or pears. Also bring water, i.e. a full bottle."],
  ["en", "He moved to the U.S.A. last year. She stayed in the U.K."],
  ["en", "We sell pens, paper, etc. The shop closes at six."],
  ["en", "See Fig. 3 and vol. 2, no. 4, pp. 10-12. Then stop."],
  ["en", "Prof. Xavier vs. Dr. Doom: who wins? Nobody knows."],
  ["en", "St. Louis is on the Mississippi. Mt. Everest is tall."],
  // Initials
  ["en", "J. R. R. Tolkien wrote The Hobbit. It was published in 1937."],
  ["en", "W. E. B. Du Bois wrote extensively. His work remains influential."],
  ["en", "George W. Bush spoke. Then John F. Kennedy's speech was replayed."],
  // Times and numbers
  ["en", "We met at 5 p.m. Then we left."],
  ["en", "The meeting starts at 9 a.m. sharp and ends at 5 p.m. on Friday."],
  ["en", "Pi is roughly 3.14 and e is 2.718. Both are irrational."],
  ["en", "It costs $29.95. Shipping is $4.50 extra."],
  ["en", "Version 1.0.32 was released. Your IP address is 192.168.1.1. Enter it."],
  ["en", "The value is 0.5. Or maybe .5 is enough."],
  // Ellipses
  ["en", "Wait... Then continue."],
  ["en", "That's strange... but possible. Let's check."],
  ["en", "Well… I don't know. Maybe…"],
  ["en", "And then. . . nothing happened. The end."],
  // Quotes and attributed questions/exclamations
  ["en", '"Stop!" he said. The car halted.'],
  ["en", "“Are you ready?” she asked. I nodded."],
  ["en", "'Really?' she wondered aloud. Nobody answered."],
  ["en", 'He said, "I am done." Then he left.'],
  ["en", "She whispered, “It's over.” And it was."],
  ["en", "No!!! Stop! Why?! What?? Okay."],
  ["en", "We make a good team, you and I. Did you see him?"],
  ["en", "Is it true (as they say) that it works? Yes (mostly). Fine."],
  // URLs, emails, lists
  ["en", "Go to https://example.com/help. Then click Support."],
  ["en", "Email support@example.com. We'll reply soon."],
  ["en", "Steps:\n1. Open the box.\n2. Remove the device.\n3. Plug it in."],
  ["en", "Read [1] carefully. Then [2]. Done."],
  // Paragraph breaks and whitespace
  ["en", "Title\n\nFirst paragraph. Second sentence.\n\nNew paragraph here."],
  ["en", "Line one.\r\n\r\nLine two.\n\n\n\nLine three."],
  ["en", "  Leading spaces. Trailing spaces.   "],
  ["en", "Tabs\tand\tmore.\t\tNext one."],
  ["en", "\n\nStarts with a break. Ends with one.\n\n"],
  ["en", "No terminal punctuation here"],
  ["en", ""],
  ["en", "."],
  ["en", "   "],
  // Emoji and astral characters
  ["en", "Hello 👋. Goodbye 👋! See you 😀😀 soon? 👨‍👩‍👧‍👦 Family."],
  ["en", "👋 Hello. 😀 Next"],
  ["en", "Math: 𝔘𝔫𝔦𝔠𝔬𝔡𝔢 text. 𝟘𝟙𝟚 digits. Done 🎉."],
  ["en", "Flags 🇺🇸🇪🇸. Skin tones 👍🏽. Keycap 1️⃣. End."],
  ["en", "Café is open. Next"],
  // Spanish
  ["es", "¿Cómo estás? Estoy bien. ¡Qué alegría!"],
  ["es", "El Sr. García llegó a las 5 p.m. Luego se fue."],
  ["es", "La Dra. López vive en EE. UU. desde 2010. Trabaja mucho."],
  ["es", "Vale 3,14 euros. Pague en la caja, p. ej. con tarjeta."],
  // French
  ["fr", "Bonjour ! Comment allez-vous ? Très bien, merci."],
  ["fr", "M. Dupont est arrivé. Mme Martin est partie."],
  ["fr", "Voir p. 12 pour les détails. Ensuite continuez."],
  ["fr", "« Arrêtez ! » cria-t-il. La voiture s'arrêta."],
  // German
  ["de", "Das ist z.B. wichtig. Weiter geht es."],
  ["de", "Das ist bzw. wichtig. Weiter geht es. N"],
  ["de", "Herr Dr. Müller kommt am 3. Oktober. Er bleibt bis zum 5. Mai."],
  ["de", "Es kostet 3,50 Euro usw. Danach ist Schluss."],
  ["de", "„Halt!“ rief er. Das Auto hielt an."],
  // Japanese
  ["ja", "こんにちは。次の文です。"],
  ["ja", "Dr. 田中が来ます。次の文です。"],
  ["ja", "U.S.のAWSです。次の文です。"],
  ["ja", "本当ですか？はい！そうです。「すごい。」と彼は言った。"],
  ["ja", "今日は晴れ。明日は雨…。絵文字😀もある。"],
  // Chinese
  ["zh", "你好。下一句"],
  ["zh", "今天天气很好！我们去公园吧？好的。"],
  ["zh", "他说：“你好。”然后走了。价格是3.14元。"],
  ["zh", "第一段。\n\n第二段。😀结束。"],
  // Hindi
  ["hi", "नमस्ते। यह एक वाक्य है। क्या आप ठीक हैं?"],
  ["hi", "डॉ. शर्मा आए। वे 5 बजे गए।"],
  // Others from the upstream offset tests
  ["ar", "هل أنت بخير؟ نعم"],
  ["pt", "O Sr. Silva chegou. Depois saiu."],
  ["pl", "Prof. Kowalski przyszedł. Potem wyszedł."],
  ["it", "Il dott. Rossi arriva. Poi parte."],
  ["nl", "Dr. Jansen komt. Daarna vertrekt hij."],
  ["unrecognized", "Hello. Next"],
  ["en-US", "Region codes fall back. Like this."],
];
