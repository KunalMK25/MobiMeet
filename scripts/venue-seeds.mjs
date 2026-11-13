// Candidate venue NAMES (well-known Bengaluru meetup places) — a search list, NOT data. Each is resolved against
// OpenStreetMap by scripts/build-venue-catalogue.mjs and kept only if OSM confirms the place type, a Bengaluru location
// and a matching name; everything else is dropped and reported. Format: [category, "OSM-style name, area"].
export const SEEDS = [
  // malls
  ['mall', 'Nexus Koramangala, Koramangala'], ['mall', 'Phoenix Marketcity, Mahadevapura'], ['mall', 'Orion Mall, Rajajinagar'], ['mall', 'Mantri Square Mall, Malleshwaram'],
  ['mall', 'Garuda Mall, Magrath Road'], ['mall', 'UB City, Vittal Mallya Road'], ['mall', 'Lulu Mall, Rajajinagar'], ['mall', 'Nexus Shantiniketan, Whitefield'],
  ['mall', 'Inorbit Mall, Whitefield'], ['mall', 'VR Bengaluru, Whitefield'], ['mall', 'Phoenix Mall of Asia, Yelahanka'], ['mall', 'Elements Mall, Nagavara'],
  ['mall', 'Esteem Mall, Hebbal'], ['mall', 'Gopalan Innovation Mall, JP Nagar'], ['mall', 'Vega City Mall, Bannerghatta Road'], ['mall', 'Royal Meenakshi Mall, Bannerghatta Road'],
  ['mall', 'Gopalan Signature Mall, Old Madras Road'], ['mall', 'Total Mall, Sarjapur Road'], ['mall', '1 MG Lido Mall, Ulsoor'], ['mall', 'Bangalore Central, Jayanagar'],
  ['mall', 'Forum Mall, Koramangala'], ['mall', 'Mall of Asia, Bengaluru'], ['mall', 'Brigade Gateway, Rajajinagar'], ['mall', 'Garuda Swagath Mall, Mysore Road'],
  // parks, lakes
  ['park', 'Cubbon Park'], ['park', 'Lalbagh Botanical Garden'], ['park', 'Agara Lake'], ['park', 'Sankey Tank'], ['park', 'Ulsoor Lake'], ['park', 'Hebbal Lake'],
  ['park', 'Madiwala Lake'], ['park', 'Bellandur Lake'], ['park', 'Freedom Park, Seshadri Road'], ['park', 'Bugle Rock Park, Basavanagudi'], ['park', 'Lumbini Gardens, Nagawara'],
  ['park', 'Puttenahalli Lake, JP Nagar'], ['park', 'Sarakki Lake, JP Nagar'], ['park', 'Hulimavu Lake'], ['park', 'Kaikondrahalli Lake'], ['park', 'Jakkur Lake'], ['park', 'Yelahanka Lake'],
  ['park', 'Jayaprakash Narayan Biodiversity Park'], ['park', 'Tagore Park, Jayanagar'], ['park', 'Cubbon Park Jawahar Bal Bhavan'],
  // sights and other meetup places
  ['attraction', 'Bangalore Palace'], ['attraction', 'Tipu Sultan Summer Palace'], ['attraction', 'Bull Temple, Basavanagudi'], ['attraction', 'ISKCON Temple, Rajajinagar'],
  ['attraction', 'Vidhana Soudha'], ['attraction', 'Visvesvaraya Industrial and Technological Museum'], ['attraction', 'Government Museum, Kasturba Road'], ['attraction', 'Jawaharlal Nehru Planetarium'],
  ['attraction', 'Venkatappa Art Gallery'], ['attraction', 'National Gallery of Modern Art, Palace Road'], ['attraction', 'Commercial Street'], ['attraction', 'Church Street'],
  ['attraction', 'Gandhi Bazaar'], ['attraction', 'Brigade Road'], ['attraction', 'Russell Market'], ['attraction', 'KR Market'], ['attraction', 'St. Mark\'s Cathedral'],
  ['attraction', 'Gavi Gangadhareshwara Temple'], ['attraction', 'Bangalore Fort'], ['attraction', 'Karnataka Chitrakala Parishath'], ['attraction', 'HAL Aerospace Museum'],
  ['attraction', 'Bangalore Aquarium, Cubbon Park'], ['attraction', 'Heritage Centre, HAL'], ['attraction', 'Banashankari Amma Temple'], ['attraction', 'Mantri Square Food Court'],
  // restaurants
  ['restaurant', 'Vidyarthi Bhavan, Gandhi Bazaar'], ['restaurant', 'Mavalli Tiffin Rooms, Lalbagh Road'], ['restaurant', 'Central Tiffin Room, Malleshwaram'], ['restaurant', 'Meghana Foods, Koramangala'],
  ['restaurant', 'Empire Restaurant, Indiranagar'], ['restaurant', 'Karavalli, Residency Road'], ['restaurant', 'Truffles, Koramangala'], ['restaurant', 'Corner House, Jayanagar'],
  ['restaurant', 'Brahmin\'s Coffee Bar, Shankarapuram'], ['restaurant', 'Veena Stores, Malleshwaram'], ['restaurant', 'Airlines Hotel, Madhava Nagar'], ['restaurant', 'Nagarjuna, Koramangala'],
  ['restaurant', 'Sunny\'s, Lavelle Road'], ['restaurant', 'Olive Beach, Ulsoor'], ['restaurant', 'Mamagoto, Indiranagar'], ['restaurant', 'Rameshwaram Cafe, Indiranagar'],
  ['restaurant', 'Rameshwaram Cafe, JP Nagar'], ['restaurant', 'Barbeque Nation, Koramangala'], ['restaurant', 'Absolute Barbecues, Koramangala'], ['restaurant', 'Maiyas, Jayanagar'],
  ['restaurant', 'Sri Krishna Sagar, Banashankari'], ['restaurant', 'Kamat Lokaruchi'], ['restaurant', 'Oh! Calcutta, Forum Mall'], ['restaurant', 'Biryani Zone, Koramangala'],
  ['restaurant', 'Bheemas, Church Street'], ['restaurant', 'Ebony, Brigade Road'], ['restaurant', 'Fatty Bao, Indiranagar'], ['restaurant', 'Smoke House Deli, Indiranagar'],
  ['restaurant', 'The Rameshwaram Cafe, Rajajinagar'], ['restaurant', 'MTR, Jayanagar'], ['restaurant', 'Taaza Thindi, Rajajinagar'], ['restaurant', 'Hotel Janatha, Jayanagar'],
  ['restaurant', 'Kudla, Hosur Road'], ['restaurant', 'Chai Point, Koramangala'],
  // cafes
  ['cafe', 'Koshy\'s, St. Marks Road'], ['cafe', 'Third Wave Coffee, Indiranagar'], ['cafe', 'Blue Tokai Coffee Roasters, Koramangala'], ['cafe', 'Hole in the Wall Cafe, Koramangala'],
  ['cafe', 'Dyu Art Cafe, Koramangala'], ['cafe', 'Matteo Coffea, Church Street'], ['cafe', 'Dialogues Cafe, Koramangala'], ['cafe', 'Glens Bakehouse, Lavelle Road'],
  ['cafe', 'Cafe Coffee Day Square, Vittal Mallya Road'], ['cafe', 'Starbucks, UB City'], ['cafe', 'Third Wave Coffee, Koramangala'], ['cafe', 'Third Wave Coffee, HSR Layout'],
  ['cafe', 'Blue Tokai, Indiranagar'], ['cafe', 'Cafe Azzure, Indiranagar'], ['cafe', 'Dunkin, Jayanagar'], ['cafe', 'Bangalore Baking Company, Indiranagar'],
  ['cafe', 'The Hole in the Wall Cafe, Jayanagar'], ['cafe', 'Brewed Awakening, Bannerghatta Road'], ['cafe', 'Dose Camp, Indiranagar'], ['cafe', 'Matteo Coffea, Indiranagar'],
  // pubs and bars
  ['bar', 'Toit, Indiranagar'], ['bar', 'Big Pitcher, Old Madras Road'], ['bar', 'Church Street Social, Church Street'], ['bar', 'Social, Koramangala'], ['bar', 'Windmills Craftworks, Whitefield'],
  ['bar', 'Biergarten, Whitefield'], ['bar', 'Byg Brewski Brewing Company, Sarjapur Road'], ['bar', 'Arbor Brewing Company, Brigade Road'], ['bar', 'The Biere Club, Vittal Mallya Road'],
  ['bar', 'Pecos, Rest House Road'], ['bar', 'Hard Rock Cafe, Church Street'], ['bar', 'The Permit Room, Indiranagar'], ['bar', 'Vapour Pub and Brewery, Koramangala'], ['bar', 'Bier Library, Koramangala'],
  ['bar', '1522 The Pub, Indiranagar'], ['bar', 'Monkey Bar, Residency Road'], ['bar', 'Loft 38, Indiranagar'], ['bar', 'Bob\'s Bar, Koramangala'], ['bar', 'Independence Brewing Company, Sarjapur Road'],
  ['bar', 'Brewsky, Koramangala'], ['bar', 'Prost Brew Pub, Koramangala'], ['bar', 'Beer Cafe, Koramangala'], ['bar', 'The Black Rabbit, Indiranagar'], ['bar', 'Skyye, UB City'],
  // clubs and nightlife
  ['club', 'Skyye Lounge, UB City'], ['club', 'Fandom at Gilly\'s Redefined, Koramangala'], ['club', 'Pasha, UB City'], ['club', 'The Piano Man Jazz Club, Koramangala'], ['club', 'Hammer, Church Street'],
  ['club', 'Opus, Indiranagar'], ['club', 'High Ultra Lounge, Ashok Nagar'], ['club', 'Club Cabana, Koramangala'], ['club', 'XU, Whitefield'], ['club', 'The Humming Tree, Indiranagar'],
  ['club', 'Arbor Brewing Company, Brigade Road'], ['club', 'Prost, Koramangala'], ['club', 'Toit, Indiranagar'], ['club', 'Social, Indiranagar'], ['club', 'Fiction, Brigade Road'],
  // entertainment
  ['entertainment', 'PVR Forum Mall, Koramangala'], ['entertainment', 'INOX Garuda Mall, Magrath Road'], ['entertainment', 'PVR Orion Mall, Rajajinagar'], ['entertainment', 'INOX Mantri Square, Malleshwaram'],
  ['entertainment', 'PVR Phoenix Marketcity, Mahadevapura'], ['entertainment', 'Cinepolis Nexus Shantiniketan, Whitefield'], ['entertainment', 'Cinepolis Royal Meenakshi Mall, Bannerghatta Road'],
  ['entertainment', 'INOX Lido Mall, Ulsoor'], ['entertainment', 'PVR Vega City, Bannerghatta Road'], ['entertainment', 'Smaaash, Bengaluru'], ['entertainment', 'Rangoli Metro Art Center, MG Road'],
  ['entertainment', 'Ranga Shankara, JP Nagar'], ['entertainment', 'Chowdiah Memorial Hall, Gayathri Devi Park'], ['entertainment', 'Ravindra Kalakshetra, JC Road'], ['entertainment', 'Bangalore Turf Club, Race Course Road'],
  ['entertainment', 'Sree Kanteerava Indoor Stadium'], ['entertainment', 'Timezone, Forum Mall'], ['entertainment', 'Bowling, Phoenix Marketcity'], ['entertainment', 'Fun World, Palace Grounds'],
  ['entertainment', 'Gopalan Cinemas, Bannerghatta Road'], ['entertainment', 'PVR Nexus Mall, Koramangala'], ['entertainment', 'INOX Phoenix Mall of Asia, Yelahanka'], ['entertainment', 'Cinepolis Orion Mall, Rajajinagar'],
  ['entertainment', 'PVR Lulu Mall, Rajajinagar'], ['entertainment', 'INOX Forum Mall, Koramangala'], ['entertainment', 'PVR VR Bengaluru, Whitefield'], ['entertainment', 'Escape Hunt, Indiranagar'],
  // second batch: areas with little coverage (Whitefield / Hoodi, Electronic City, Mysuru Road / Kengeri, Tumkur Road, Banashankari, HSR / BTM)
  ['mall', 'Phoenix Marketcity'], ['mall', 'Inorbit Mall'], ['mall', 'Nexus Shantiniketan'], ['mall', 'VR Bengaluru'], ['mall', 'Forum Shantiniketan'], ['mall', 'Jayanagar Shopping Complex'],
  ['mall', 'Gopalan Arcade Mall'], ['mall', 'Mantri Mall'], ['mall', 'Elita Promenade'], ['mall', 'Central Mall'],
  ['park', 'Kadugodi Tree Park'], ['park', 'Gokula Extension Park'], ['park', 'Jayanagar 4th Block Park'], ['park', 'BDA Park, HSR Layout'], ['park', 'Banashankari Lake'], ['park', 'Mahatma Gandhi Park'],
  ['attraction', 'Sri Sathya Sai Baba Ashram, Whitefield'], ['attraction', 'Bangalore International Exhibition Centre'], ['attraction', 'Gali Anjaneya Temple'], ['attraction', 'ISKCON Temple'], ['attraction', 'Banashankari Temple'],
  ['attraction', 'Jnanabharathi Campus'], ['attraction', 'Infosys Campus, Electronic City'], ['attraction', 'ITPL Whitefield'], ['attraction', 'Kempegowda Bus Station'],
  ['restaurant', 'Rameshwaram Cafe, Whitefield'], ['restaurant', 'Empire Restaurant, Whitefield'], ['restaurant', 'Meghana Foods, Whitefield'], ['restaurant', 'Empire Restaurant, Electronic City'], ['restaurant', 'Rameshwaram Cafe, Banashankari'],
  ['restaurant', 'MTR, Whitefield'], ['restaurant', 'Truffles, HSR Layout'], ['restaurant', 'Meghana Foods, Jayanagar'], ['restaurant', 'Bhimas, Whitefield'], ['restaurant', 'Kamat, Kengeri'],
  ['cafe', 'Third Wave Coffee, Whitefield'], ['cafe', 'Starbucks, Whitefield'], ['cafe', 'Blue Tokai, Whitefield'], ['cafe', 'Starbucks, Electronic City'], ['cafe', 'Third Wave Coffee, JP Nagar'], ['cafe', 'Starbucks, Jayanagar'],
  ['bar', 'Toit, Whitefield'], ['bar', 'Social, Whitefield'], ['bar', 'Bar Stock Exchange, Koramangala'], ['bar', 'Social, HSR Layout'], ['bar', 'Barleyz, Koramangala'], ['bar', 'Brewsky, Whitefield'],
  ['entertainment', 'PVR Phoenix Marketcity, Whitefield'], ['entertainment', 'PVR VR Bengaluru, Whitefield'], ['entertainment', 'INOX Garuda Mall, Magrath Road'], ['entertainment', 'Cinepolis, Whitefield'],
  ['entertainment', 'Bowling, Whitefield'], ['entertainment', 'Koramangala Indoor Stadium'], ['entertainment', 'PVR, Electronic City'],
].map(([cat, q]) => ({ cat, q: q.includes('Bengaluru') ? q : `${q}, Bengaluru`,
  street: cat === 'attraction' && /^(Commercial Street|Church Street|Brigade Road|Gandhi Bazaar)\b/.test(q) }));   // streets: roads are acceptable ONLY for these
