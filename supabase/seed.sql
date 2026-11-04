-- Signalerna som redan finns i Claude-versionen av Tradeloggen
insert into public.signals (id, aktie, ticker, valuta, datum, kalla, skal, kop, stopp, mal1, mal2, stod, motstand, knockout_max, rapport, skapad) values
('sig-abb-20261104', 'ABB', 'OMXSTO:ABB', 'SEK', '4 nov', 'Analyser: Viscaria, ABB och AMD',
 'Han hade köpt idag om han inte redan ägt mycket – rekordorderingång (+40 %), styrelsen köpte för 18 Mkr.',
 834.6, 795, 898.2, 1007, '{834.6,808}', '{898.2,1007}', 768, null, '2026-11-04T11:48:20Z'),
('sig-viscaria-20261104', 'Viscaria', 'OMXSTO:VISC', 'SEK', '4 nov', 'Analyser: Viscaria, ABB och AMD',
 'Planerar att utöka sitt lilla innehav, möjligen redan 5 nov om Q3-rapporten bekräftar stabilitet; finansiering är huvudkatalysatorn.',
 16.08, 15.8, 17.46, 19.24, '{16.08,16}', '{17.46,19.24}', 15.2, 'Q3-rapport 5 nov kl 07.30 – högrisk, köp efter rapporten', '2026-11-04T11:48:20Z'),
('sig-vistra-20261103', 'Vistra', 'NYSE:VST', 'USD', '3 nov', 'Analyser: Latour, Vistra och AstraZeneca',
 'Han kommer sannolikt att öka stegvis – AI-datacenter driver elbehovet och 20-årigt elavtal med Meta.',
 134.95, 130.5, 140.22, 158.61, '{134.95,132.65}', '{140.22,158.61}', 126, 'Rapport 6 nov – vänta till efter eller köp utan hävstång', '2026-11-03T11:50:51Z'),
('sig-alphabet-20261102', 'Alphabet', 'NASDAQ:GOOGL', 'USD', '2 nov', 'Analyser: SpaceX, Alphabet och Meta',
 'Han kommer sannolikt att köpa fler om aktien stabiliseras i köpzonen 256,64–272,36 – Google Cloud +103 % och stark sökaffär.',
 268, 252.8, 286.87, 314.64, '{272.36,256.64}', '{286.87,314.64}', 243, null, '2026-11-02T12:14:17Z')
on conflict (id) do nothing;
