import { Effect, Schema } from "effect"
import DESCRIPTION from "./country.txt"
import * as Tool from "./tool"

const ACTIONS = ["lookup", "validate", "list", "info"] as const
const CODE_KINDS = ["alpha2", "alpha3", "numeric", "any"] as const
const REGIONS = ["Africa", "Americas", "Asia", "Europe", "Oceania", "Antarctic"] as const

const MAX_LIMIT = 300
const DEFAULT_LIMIT = 50

export const Parameters = Schema.Struct({
  action: Schema.Literals(ACTIONS).annotate({ description: ACTIONS.join(" | ") }),
  query: Schema.optional(Schema.String.check(Schema.isMaxLength(200))).annotate({
    description:
      "Required for lookup/validate. Accepts alpha-2/alpha-3/numeric code, common name, or flag emoji. Case-insensitive.",
  }),
  code_kind: Schema.optional(Schema.Literals(CODE_KINDS)).annotate({
    description: "Filter for validate. Default 'any'.",
  }),
  region: Schema.optional(Schema.Literals(REGIONS)).annotate({
    description: "Filter list to one continental region.",
  }),
  subregion: Schema.optional(Schema.String.check(Schema.isMaxLength(60))).annotate({
    description: "Substring filter on UN M.49 subregion (case-insensitive).",
  }),
  limit: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(MAX_LIMIT)),
  ).annotate({
    description: `Cap on results (1-${MAX_LIMIT}). Default ${DEFAULT_LIMIT}.`,
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>
type Action = (typeof ACTIONS)[number]
type Region = (typeof REGIONS)[number]
type CodeKind = (typeof CODE_KINDS)[number]

export type Country = {
  alpha2: string
  alpha3: string
  numeric: string
  name: string
  region: Region
  subregion: string
  calling_code: string
  flag: string
}

type Metadata = {
  action: Action
  matches?: number
  total?: number
  region?: Region
  subregion?: string
  query?: string
  code_kind?: CodeKind
  matched?: Country
  countries?: Country[]
  ok?: boolean
}

const done = (result: Tool.ExecuteResult<Metadata>) => result

// ---------- packed data ----------
//
// Each row: [alpha2, alpha3, numeric, name, region, subregion, calling_code]
// Calling codes are international dial-prefixes; for NANP shared blocks the
// individual subscriber prefix would also help, but this is a country tool.
// Data sourced offline from ISO 3166-1 + UN M.49 + ITU-T E.164 (2024).
const ROWS: ReadonlyArray<readonly [string, string, string, string, Region, string, string]> = [
  ["AD", "AND", "020", "Andorra", "Europe", "Southern Europe", "+376"],
  ["AE", "ARE", "784", "United Arab Emirates", "Asia", "Western Asia", "+971"],
  ["AF", "AFG", "004", "Afghanistan", "Asia", "Southern Asia", "+93"],
  ["AG", "ATG", "028", "Antigua and Barbuda", "Americas", "Caribbean", "+1-268"],
  ["AI", "AIA", "660", "Anguilla", "Americas", "Caribbean", "+1-264"],
  ["AL", "ALB", "008", "Albania", "Europe", "Southern Europe", "+355"],
  ["AM", "ARM", "051", "Armenia", "Asia", "Western Asia", "+374"],
  ["AO", "AGO", "024", "Angola", "Africa", "Middle Africa", "+244"],
  ["AQ", "ATA", "010", "Antarctica", "Antarctic", "Antarctica", ""],
  ["AR", "ARG", "032", "Argentina", "Americas", "South America", "+54"],
  ["AS", "ASM", "016", "American Samoa", "Oceania", "Polynesia", "+1-684"],
  ["AT", "AUT", "040", "Austria", "Europe", "Western Europe", "+43"],
  ["AU", "AUS", "036", "Australia", "Oceania", "Australia and New Zealand", "+61"],
  ["AW", "ABW", "533", "Aruba", "Americas", "Caribbean", "+297"],
  ["AX", "ALA", "248", "\u00c5land Islands", "Europe", "Northern Europe", "+358-18"],
  ["AZ", "AZE", "031", "Azerbaijan", "Asia", "Western Asia", "+994"],
  ["BA", "BIH", "070", "Bosnia and Herzegovina", "Europe", "Southern Europe", "+387"],
  ["BB", "BRB", "052", "Barbados", "Americas", "Caribbean", "+1-246"],
  ["BD", "BGD", "050", "Bangladesh", "Asia", "Southern Asia", "+880"],
  ["BE", "BEL", "056", "Belgium", "Europe", "Western Europe", "+32"],
  ["BF", "BFA", "854", "Burkina Faso", "Africa", "Western Africa", "+226"],
  ["BG", "BGR", "100", "Bulgaria", "Europe", "Eastern Europe", "+359"],
  ["BH", "BHR", "048", "Bahrain", "Asia", "Western Asia", "+973"],
  ["BI", "BDI", "108", "Burundi", "Africa", "Eastern Africa", "+257"],
  ["BJ", "BEN", "204", "Benin", "Africa", "Western Africa", "+229"],
  ["BL", "BLM", "652", "Saint Barth\u00e9lemy", "Americas", "Caribbean", "+590"],
  ["BM", "BMU", "060", "Bermuda", "Americas", "Northern America", "+1-441"],
  ["BN", "BRN", "096", "Brunei Darussalam", "Asia", "South-Eastern Asia", "+673"],
  ["BO", "BOL", "068", "Bolivia", "Americas", "South America", "+591"],
  ["BQ", "BES", "535", "Bonaire, Sint Eustatius and Saba", "Americas", "Caribbean", "+599"],
  ["BR", "BRA", "076", "Brazil", "Americas", "South America", "+55"],
  ["BS", "BHS", "044", "Bahamas", "Americas", "Caribbean", "+1-242"],
  ["BT", "BTN", "064", "Bhutan", "Asia", "Southern Asia", "+975"],
  ["BV", "BVT", "074", "Bouvet Island", "Antarctic", "Antarctica", ""],
  ["BW", "BWA", "072", "Botswana", "Africa", "Southern Africa", "+267"],
  ["BY", "BLR", "112", "Belarus", "Europe", "Eastern Europe", "+375"],
  ["BZ", "BLZ", "084", "Belize", "Americas", "Central America", "+501"],
  ["CA", "CAN", "124", "Canada", "Americas", "Northern America", "+1"],
  ["CC", "CCK", "166", "Cocos (Keeling) Islands", "Oceania", "Australia and New Zealand", "+61"],
  ["CD", "COD", "180", "Congo, Democratic Republic of the", "Africa", "Middle Africa", "+243"],
  ["CF", "CAF", "140", "Central African Republic", "Africa", "Middle Africa", "+236"],
  ["CG", "COG", "178", "Congo", "Africa", "Middle Africa", "+242"],
  ["CH", "CHE", "756", "Switzerland", "Europe", "Western Europe", "+41"],
  ["CI", "CIV", "384", "C\u00f4te d'Ivoire", "Africa", "Western Africa", "+225"],
  ["CK", "COK", "184", "Cook Islands", "Oceania", "Polynesia", "+682"],
  ["CL", "CHL", "152", "Chile", "Americas", "South America", "+56"],
  ["CM", "CMR", "120", "Cameroon", "Africa", "Middle Africa", "+237"],
  ["CN", "CHN", "156", "China", "Asia", "Eastern Asia", "+86"],
  ["CO", "COL", "170", "Colombia", "Americas", "South America", "+57"],
  ["CR", "CRI", "188", "Costa Rica", "Americas", "Central America", "+506"],
  ["CU", "CUB", "192", "Cuba", "Americas", "Caribbean", "+53"],
  ["CV", "CPV", "132", "Cabo Verde", "Africa", "Western Africa", "+238"],
  ["CW", "CUW", "531", "Cura\u00e7ao", "Americas", "Caribbean", "+599"],
  ["CX", "CXR", "162", "Christmas Island", "Oceania", "Australia and New Zealand", "+61"],
  ["CY", "CYP", "196", "Cyprus", "Asia", "Western Asia", "+357"],
  ["CZ", "CZE", "203", "Czechia", "Europe", "Eastern Europe", "+420"],
  ["DE", "DEU", "276", "Germany", "Europe", "Western Europe", "+49"],
  ["DJ", "DJI", "262", "Djibouti", "Africa", "Eastern Africa", "+253"],
  ["DK", "DNK", "208", "Denmark", "Europe", "Northern Europe", "+45"],
  ["DM", "DMA", "212", "Dominica", "Americas", "Caribbean", "+1-767"],
  ["DO", "DOM", "214", "Dominican Republic", "Americas", "Caribbean", "+1-809"],
  ["DZ", "DZA", "012", "Algeria", "Africa", "Northern Africa", "+213"],
  ["EC", "ECU", "218", "Ecuador", "Americas", "South America", "+593"],
  ["EE", "EST", "233", "Estonia", "Europe", "Northern Europe", "+372"],
  ["EG", "EGY", "818", "Egypt", "Africa", "Northern Africa", "+20"],
  ["EH", "ESH", "732", "Western Sahara", "Africa", "Northern Africa", "+212"],
  ["ER", "ERI", "232", "Eritrea", "Africa", "Eastern Africa", "+291"],
  ["ES", "ESP", "724", "Spain", "Europe", "Southern Europe", "+34"],
  ["ET", "ETH", "231", "Ethiopia", "Africa", "Eastern Africa", "+251"],
  ["FI", "FIN", "246", "Finland", "Europe", "Northern Europe", "+358"],
  ["FJ", "FJI", "242", "Fiji", "Oceania", "Melanesia", "+679"],
  ["FK", "FLK", "238", "Falkland Islands (Malvinas)", "Americas", "South America", "+500"],
  ["FM", "FSM", "583", "Micronesia, Federated States of", "Oceania", "Micronesia", "+691"],
  ["FO", "FRO", "234", "Faroe Islands", "Europe", "Northern Europe", "+298"],
  ["FR", "FRA", "250", "France", "Europe", "Western Europe", "+33"],
  ["GA", "GAB", "266", "Gabon", "Africa", "Middle Africa", "+241"],
  ["GB", "GBR", "826", "United Kingdom", "Europe", "Northern Europe", "+44"],
  ["GD", "GRD", "308", "Grenada", "Americas", "Caribbean", "+1-473"],
  ["GE", "GEO", "268", "Georgia", "Asia", "Western Asia", "+995"],
  ["GF", "GUF", "254", "French Guiana", "Americas", "South America", "+594"],
  ["GG", "GGY", "831", "Guernsey", "Europe", "Northern Europe", "+44-1481"],
  ["GH", "GHA", "288", "Ghana", "Africa", "Western Africa", "+233"],
  ["GI", "GIB", "292", "Gibraltar", "Europe", "Southern Europe", "+350"],
  ["GL", "GRL", "304", "Greenland", "Americas", "Northern America", "+299"],
  ["GM", "GMB", "270", "Gambia", "Africa", "Western Africa", "+220"],
  ["GN", "GIN", "324", "Guinea", "Africa", "Western Africa", "+224"],
  ["GP", "GLP", "312", "Guadeloupe", "Americas", "Caribbean", "+590"],
  ["GQ", "GNQ", "226", "Equatorial Guinea", "Africa", "Middle Africa", "+240"],
  ["GR", "GRC", "300", "Greece", "Europe", "Southern Europe", "+30"],
  ["GS", "SGS", "239", "South Georgia and the South Sandwich Islands", "Antarctic", "Antarctica", "+500"],
  ["GT", "GTM", "320", "Guatemala", "Americas", "Central America", "+502"],
  ["GU", "GUM", "316", "Guam", "Oceania", "Micronesia", "+1-671"],
  ["GW", "GNB", "624", "Guinea-Bissau", "Africa", "Western Africa", "+245"],
  ["GY", "GUY", "328", "Guyana", "Americas", "South America", "+592"],
  ["HK", "HKG", "344", "Hong Kong", "Asia", "Eastern Asia", "+852"],
  ["HM", "HMD", "334", "Heard Island and McDonald Islands", "Antarctic", "Antarctica", ""],
  ["HN", "HND", "340", "Honduras", "Americas", "Central America", "+504"],
  ["HR", "HRV", "191", "Croatia", "Europe", "Southern Europe", "+385"],
  ["HT", "HTI", "332", "Haiti", "Americas", "Caribbean", "+509"],
  ["HU", "HUN", "348", "Hungary", "Europe", "Eastern Europe", "+36"],
  ["ID", "IDN", "360", "Indonesia", "Asia", "South-Eastern Asia", "+62"],
  ["IE", "IRL", "372", "Ireland", "Europe", "Northern Europe", "+353"],
  ["IL", "ISR", "376", "Israel", "Asia", "Western Asia", "+972"],
  ["IM", "IMN", "833", "Isle of Man", "Europe", "Northern Europe", "+44-1624"],
  ["IN", "IND", "356", "India", "Asia", "Southern Asia", "+91"],
  ["IO", "IOT", "086", "British Indian Ocean Territory", "Africa", "Eastern Africa", "+246"],
  ["IQ", "IRQ", "368", "Iraq", "Asia", "Western Asia", "+964"],
  ["IR", "IRN", "364", "Iran, Islamic Republic of", "Asia", "Southern Asia", "+98"],
  ["IS", "ISL", "352", "Iceland", "Europe", "Northern Europe", "+354"],
  ["IT", "ITA", "380", "Italy", "Europe", "Southern Europe", "+39"],
  ["JE", "JEY", "832", "Jersey", "Europe", "Northern Europe", "+44-1534"],
  ["JM", "JAM", "388", "Jamaica", "Americas", "Caribbean", "+1-876"],
  ["JO", "JOR", "400", "Jordan", "Asia", "Western Asia", "+962"],
  ["JP", "JPN", "392", "Japan", "Asia", "Eastern Asia", "+81"],
  ["KE", "KEN", "404", "Kenya", "Africa", "Eastern Africa", "+254"],
  ["KG", "KGZ", "417", "Kyrgyzstan", "Asia", "Central Asia", "+996"],
  ["KH", "KHM", "116", "Cambodia", "Asia", "South-Eastern Asia", "+855"],
  ["KI", "KIR", "296", "Kiribati", "Oceania", "Micronesia", "+686"],
  ["KM", "COM", "174", "Comoros", "Africa", "Eastern Africa", "+269"],
  ["KN", "KNA", "659", "Saint Kitts and Nevis", "Americas", "Caribbean", "+1-869"],
  ["KP", "PRK", "408", "Korea, Democratic People's Republic of", "Asia", "Eastern Asia", "+850"],
  ["KR", "KOR", "410", "Korea, Republic of", "Asia", "Eastern Asia", "+82"],
  ["KW", "KWT", "414", "Kuwait", "Asia", "Western Asia", "+965"],
  ["KY", "CYM", "136", "Cayman Islands", "Americas", "Caribbean", "+1-345"],
  ["KZ", "KAZ", "398", "Kazakhstan", "Asia", "Central Asia", "+7"],
  ["LA", "LAO", "418", "Lao People's Democratic Republic", "Asia", "South-Eastern Asia", "+856"],
  ["LB", "LBN", "422", "Lebanon", "Asia", "Western Asia", "+961"],
  ["LC", "LCA", "662", "Saint Lucia", "Americas", "Caribbean", "+1-758"],
  ["LI", "LIE", "438", "Liechtenstein", "Europe", "Western Europe", "+423"],
  ["LK", "LKA", "144", "Sri Lanka", "Asia", "Southern Asia", "+94"],
  ["LR", "LBR", "430", "Liberia", "Africa", "Western Africa", "+231"],
  ["LS", "LSO", "426", "Lesotho", "Africa", "Southern Africa", "+266"],
  ["LT", "LTU", "440", "Lithuania", "Europe", "Northern Europe", "+370"],
  ["LU", "LUX", "442", "Luxembourg", "Europe", "Western Europe", "+352"],
  ["LV", "LVA", "428", "Latvia", "Europe", "Northern Europe", "+371"],
  ["LY", "LBY", "434", "Libya", "Africa", "Northern Africa", "+218"],
  ["MA", "MAR", "504", "Morocco", "Africa", "Northern Africa", "+212"],
  ["MC", "MCO", "492", "Monaco", "Europe", "Western Europe", "+377"],
  ["MD", "MDA", "498", "Moldova, Republic of", "Europe", "Eastern Europe", "+373"],
  ["ME", "MNE", "499", "Montenegro", "Europe", "Southern Europe", "+382"],
  ["MF", "MAF", "663", "Saint Martin (French part)", "Americas", "Caribbean", "+590"],
  ["MG", "MDG", "450", "Madagascar", "Africa", "Eastern Africa", "+261"],
  ["MH", "MHL", "584", "Marshall Islands", "Oceania", "Micronesia", "+692"],
  ["MK", "MKD", "807", "North Macedonia", "Europe", "Southern Europe", "+389"],
  ["ML", "MLI", "466", "Mali", "Africa", "Western Africa", "+223"],
  ["MM", "MMR", "104", "Myanmar", "Asia", "South-Eastern Asia", "+95"],
  ["MN", "MNG", "496", "Mongolia", "Asia", "Eastern Asia", "+976"],
  ["MO", "MAC", "446", "Macao", "Asia", "Eastern Asia", "+853"],
  ["MP", "MNP", "580", "Northern Mariana Islands", "Oceania", "Micronesia", "+1-670"],
  ["MQ", "MTQ", "474", "Martinique", "Americas", "Caribbean", "+596"],
  ["MR", "MRT", "478", "Mauritania", "Africa", "Western Africa", "+222"],
  ["MS", "MSR", "500", "Montserrat", "Americas", "Caribbean", "+1-664"],
  ["MT", "MLT", "470", "Malta", "Europe", "Southern Europe", "+356"],
  ["MU", "MUS", "480", "Mauritius", "Africa", "Eastern Africa", "+230"],
  ["MV", "MDV", "462", "Maldives", "Asia", "Southern Asia", "+960"],
  ["MW", "MWI", "454", "Malawi", "Africa", "Eastern Africa", "+265"],
  ["MX", "MEX", "484", "Mexico", "Americas", "Central America", "+52"],
  ["MY", "MYS", "458", "Malaysia", "Asia", "South-Eastern Asia", "+60"],
  ["MZ", "MOZ", "508", "Mozambique", "Africa", "Eastern Africa", "+258"],
  ["NA", "NAM", "516", "Namibia", "Africa", "Southern Africa", "+264"],
  ["NC", "NCL", "540", "New Caledonia", "Oceania", "Melanesia", "+687"],
  ["NE", "NER", "562", "Niger", "Africa", "Western Africa", "+227"],
  ["NF", "NFK", "574", "Norfolk Island", "Oceania", "Australia and New Zealand", "+672"],
  ["NG", "NGA", "566", "Nigeria", "Africa", "Western Africa", "+234"],
  ["NI", "NIC", "558", "Nicaragua", "Americas", "Central America", "+505"],
  ["NL", "NLD", "528", "Netherlands", "Europe", "Western Europe", "+31"],
  ["NO", "NOR", "578", "Norway", "Europe", "Northern Europe", "+47"],
  ["NP", "NPL", "524", "Nepal", "Asia", "Southern Asia", "+977"],
  ["NR", "NRU", "520", "Nauru", "Oceania", "Micronesia", "+674"],
  ["NU", "NIU", "570", "Niue", "Oceania", "Polynesia", "+683"],
  ["NZ", "NZL", "554", "New Zealand", "Oceania", "Australia and New Zealand", "+64"],
  ["OM", "OMN", "512", "Oman", "Asia", "Western Asia", "+968"],
  ["PA", "PAN", "591", "Panama", "Americas", "Central America", "+507"],
  ["PE", "PER", "604", "Peru", "Americas", "South America", "+51"],
  ["PF", "PYF", "258", "French Polynesia", "Oceania", "Polynesia", "+689"],
  ["PG", "PNG", "598", "Papua New Guinea", "Oceania", "Melanesia", "+675"],
  ["PH", "PHL", "608", "Philippines", "Asia", "South-Eastern Asia", "+63"],
  ["PK", "PAK", "586", "Pakistan", "Asia", "Southern Asia", "+92"],
  ["PL", "POL", "616", "Poland", "Europe", "Eastern Europe", "+48"],
  ["PM", "SPM", "666", "Saint Pierre and Miquelon", "Americas", "Northern America", "+508"],
  ["PN", "PCN", "612", "Pitcairn", "Oceania", "Polynesia", "+64"],
  ["PR", "PRI", "630", "Puerto Rico", "Americas", "Caribbean", "+1-787"],
  ["PS", "PSE", "275", "Palestine, State of", "Asia", "Western Asia", "+970"],
  ["PT", "PRT", "620", "Portugal", "Europe", "Southern Europe", "+351"],
  ["PW", "PLW", "585", "Palau", "Oceania", "Micronesia", "+680"],
  ["PY", "PRY", "600", "Paraguay", "Americas", "South America", "+595"],
  ["QA", "QAT", "634", "Qatar", "Asia", "Western Asia", "+974"],
  ["RE", "REU", "638", "R\u00e9union", "Africa", "Eastern Africa", "+262"],
  ["RO", "ROU", "642", "Romania", "Europe", "Eastern Europe", "+40"],
  ["RS", "SRB", "688", "Serbia", "Europe", "Southern Europe", "+381"],
  ["RU", "RUS", "643", "Russian Federation", "Europe", "Eastern Europe", "+7"],
  ["RW", "RWA", "646", "Rwanda", "Africa", "Eastern Africa", "+250"],
  ["SA", "SAU", "682", "Saudi Arabia", "Asia", "Western Asia", "+966"],
  ["SB", "SLB", "090", "Solomon Islands", "Oceania", "Melanesia", "+677"],
  ["SC", "SYC", "690", "Seychelles", "Africa", "Eastern Africa", "+248"],
  ["SD", "SDN", "729", "Sudan", "Africa", "Northern Africa", "+249"],
  ["SE", "SWE", "752", "Sweden", "Europe", "Northern Europe", "+46"],
  ["SG", "SGP", "702", "Singapore", "Asia", "South-Eastern Asia", "+65"],
  ["SH", "SHN", "654", "Saint Helena, Ascension and Tristan da Cunha", "Africa", "Western Africa", "+290"],
  ["SI", "SVN", "705", "Slovenia", "Europe", "Southern Europe", "+386"],
  ["SJ", "SJM", "744", "Svalbard and Jan Mayen", "Europe", "Northern Europe", "+47-79"],
  ["SK", "SVK", "703", "Slovakia", "Europe", "Eastern Europe", "+421"],
  ["SL", "SLE", "694", "Sierra Leone", "Africa", "Western Africa", "+232"],
  ["SM", "SMR", "674", "San Marino", "Europe", "Southern Europe", "+378"],
  ["SN", "SEN", "686", "Senegal", "Africa", "Western Africa", "+221"],
  ["SO", "SOM", "706", "Somalia", "Africa", "Eastern Africa", "+252"],
  ["SR", "SUR", "740", "Suriname", "Americas", "South America", "+597"],
  ["SS", "SSD", "728", "South Sudan", "Africa", "Eastern Africa", "+211"],
  ["ST", "STP", "678", "Sao Tome and Principe", "Africa", "Middle Africa", "+239"],
  ["SV", "SLV", "222", "El Salvador", "Americas", "Central America", "+503"],
  ["SX", "SXM", "534", "Sint Maarten (Dutch part)", "Americas", "Caribbean", "+1-721"],
  ["SY", "SYR", "760", "Syrian Arab Republic", "Asia", "Western Asia", "+963"],
  ["SZ", "SWZ", "748", "Eswatini", "Africa", "Southern Africa", "+268"],
  ["TC", "TCA", "796", "Turks and Caicos Islands", "Americas", "Caribbean", "+1-649"],
  ["TD", "TCD", "148", "Chad", "Africa", "Middle Africa", "+235"],
  ["TF", "ATF", "260", "French Southern Territories", "Antarctic", "Antarctica", ""],
  ["TG", "TGO", "768", "Togo", "Africa", "Western Africa", "+228"],
  ["TH", "THA", "764", "Thailand", "Asia", "South-Eastern Asia", "+66"],
  ["TJ", "TJK", "762", "Tajikistan", "Asia", "Central Asia", "+992"],
  ["TK", "TKL", "772", "Tokelau", "Oceania", "Polynesia", "+690"],
  ["TL", "TLS", "626", "Timor-Leste", "Asia", "South-Eastern Asia", "+670"],
  ["TM", "TKM", "795", "Turkmenistan", "Asia", "Central Asia", "+993"],
  ["TN", "TUN", "788", "Tunisia", "Africa", "Northern Africa", "+216"],
  ["TO", "TON", "776", "Tonga", "Oceania", "Polynesia", "+676"],
  ["TR", "TUR", "792", "T\u00fcrkiye", "Asia", "Western Asia", "+90"],
  ["TT", "TTO", "780", "Trinidad and Tobago", "Americas", "Caribbean", "+1-868"],
  ["TV", "TUV", "798", "Tuvalu", "Oceania", "Polynesia", "+688"],
  ["TW", "TWN", "158", "Taiwan, Province of China", "Asia", "Eastern Asia", "+886"],
  ["TZ", "TZA", "834", "Tanzania, United Republic of", "Africa", "Eastern Africa", "+255"],
  ["UA", "UKR", "804", "Ukraine", "Europe", "Eastern Europe", "+380"],
  ["UG", "UGA", "800", "Uganda", "Africa", "Eastern Africa", "+256"],
  ["UM", "UMI", "581", "United States Minor Outlying Islands", "Oceania", "Micronesia", "+1"],
  ["US", "USA", "840", "United States", "Americas", "Northern America", "+1"],
  ["UY", "URY", "858", "Uruguay", "Americas", "South America", "+598"],
  ["UZ", "UZB", "860", "Uzbekistan", "Asia", "Central Asia", "+998"],
  ["VA", "VAT", "336", "Holy See", "Europe", "Southern Europe", "+39-06"],
  ["VC", "VCT", "670", "Saint Vincent and the Grenadines", "Americas", "Caribbean", "+1-784"],
  ["VE", "VEN", "862", "Venezuela, Bolivarian Republic of", "Americas", "South America", "+58"],
  ["VG", "VGB", "092", "Virgin Islands, British", "Americas", "Caribbean", "+1-284"],
  ["VI", "VIR", "850", "Virgin Islands, U.S.", "Americas", "Caribbean", "+1-340"],
  ["VN", "VNM", "704", "Viet Nam", "Asia", "South-Eastern Asia", "+84"],
  ["VU", "VUT", "548", "Vanuatu", "Oceania", "Melanesia", "+678"],
  ["WF", "WLF", "876", "Wallis and Futuna", "Oceania", "Polynesia", "+681"],
  ["WS", "WSM", "882", "Samoa", "Oceania", "Polynesia", "+685"],
  ["YE", "YEM", "887", "Yemen", "Asia", "Western Asia", "+967"],
  ["YT", "MYT", "175", "Mayotte", "Africa", "Eastern Africa", "+262"],
  ["ZA", "ZAF", "710", "South Africa", "Africa", "Southern Africa", "+27"],
  ["ZM", "ZMB", "894", "Zambia", "Africa", "Eastern Africa", "+260"],
  ["ZW", "ZWE", "716", "Zimbabwe", "Africa", "Eastern Africa", "+263"],
] as const

// Optional aliases that should resolve to the canonical alpha-2.
// Keys must already be lowercased & accent-stripped.
const ALIASES: Record<string, string> = {
  "uk": "GB",
  "great britain": "GB",
  "britain": "GB",
  "england": "GB",
  "scotland": "GB",
  "wales": "GB",
  "northern ireland": "GB",
  "usa": "US",
  "u.s.a.": "US",
  "u.s.": "US",
  "us of a": "US",
  "america": "US",
  "uae": "AE",
  "south korea": "KR",
  "north korea": "KP",
  "russia": "RU",
  "iran": "IR",
  "syria": "SY",
  "vietnam": "VN",
  "laos": "LA",
  "taiwan": "TW",
  "macau": "MO",
  "ivory coast": "CI",
  "burma": "MM",
  "swaziland": "SZ",
  "czech republic": "CZ",
  "vatican": "VA",
  "vatican city": "VA",
  "holy see": "VA",
  "palestine": "PS",
  "moldova": "MD",
  "bolivia": "BO",
  "venezuela": "VE",
  "tanzania": "TZ",
  "micronesia": "FM",
  "dr congo": "CD",
  "drc": "CD",
  "republic of the congo": "CG",
  "cape verde": "CV",
  "east timor": "TL",
  "macedonia": "MK",
  "turkey": "TR",
  "cocos islands": "CC",
  "saint barts": "BL",
}

function flagFromAlpha2(a2: string): string {
  if (!/^[A-Z]{2}$/.test(a2)) return ""
  // Regional indicator symbols start at 0x1F1E6 ('A').
  const A = 0x1f1e6
  const cp1 = A + (a2.charCodeAt(0) - "A".charCodeAt(0))
  const cp2 = A + (a2.charCodeAt(1) - "A".charCodeAt(0))
  return String.fromCodePoint(cp1) + String.fromCodePoint(cp2)
}

function normalize(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
}

function alpha2FromFlag(s: string): string | undefined {
  // Two regional-indicator code points recover ASCII alpha-2.
  const cps: number[] = []
  for (const ch of s) {
    const cp = ch.codePointAt(0)
    if (cp !== undefined) cps.push(cp)
  }
  if (cps.length !== 2) return undefined
  const A = 0x1f1e6
  if (cps.some((cp) => cp < A || cp > A + 25)) return undefined
  const c0 = String.fromCharCode(65 + (cps[0]! - A))
  const c1 = String.fromCharCode(65 + (cps[1]! - A))
  return c0 + c1
}

const ROW_TO_COUNTRY = (row: (typeof ROWS)[number]): Country => ({
  alpha2: row[0],
  alpha3: row[1],
  numeric: row[2],
  name: row[3],
  region: row[4],
  subregion: row[5],
  calling_code: row[6],
  flag: flagFromAlpha2(row[0]),
})

// Lazy index, built once on first access.
let _index: {
  byAlpha2: Map<string, Country>
  byAlpha3: Map<string, Country>
  byNumeric: Map<string, Country>
  byName: Map<string, Country>
  countries: Country[]
} | null = null

function index() {
  if (_index) return _index
  const countries = ROWS.map(ROW_TO_COUNTRY)
  const byAlpha2 = new Map<string, Country>()
  const byAlpha3 = new Map<string, Country>()
  const byNumeric = new Map<string, Country>()
  const byName = new Map<string, Country>()
  for (const c of countries) {
    byAlpha2.set(c.alpha2, c)
    byAlpha3.set(c.alpha3, c)
    byNumeric.set(c.numeric, c)
    byName.set(normalize(c.name), c)
  }
  _index = { byAlpha2, byAlpha3, byNumeric, byName, countries }
  return _index
}

export function lookupCountry(query: string): Country | undefined {
  if (!query) return undefined
  const idx = index()

  const flagAlpha2 = alpha2FromFlag(query.trim())
  if (flagAlpha2) {
    const c = idx.byAlpha2.get(flagAlpha2)
    if (c) return c
  }

  const upper = query.trim().toUpperCase()
  if (/^[A-Z]{2}$/.test(upper)) {
    const c = idx.byAlpha2.get(upper)
    if (c) return c
  }
  if (/^[A-Z]{3}$/.test(upper)) {
    const c = idx.byAlpha3.get(upper)
    if (c) return c
  }
  if (/^[0-9]{1,3}$/.test(upper)) {
    const padded = upper.padStart(3, "0")
    const c = idx.byNumeric.get(padded)
    if (c) return c
  }

  const norm = normalize(query)
  const exact = idx.byName.get(norm)
  if (exact) return exact

  const aliasA2 = ALIASES[norm]
  if (aliasA2) {
    const c = idx.byAlpha2.get(aliasA2)
    if (c) return c
  }

  // Try a substring match on any name; prefer the country whose normalised
  // name starts with the query so "korea" resolves to KR over KP.
  const candidates = idx.countries.filter((c) => normalize(c.name).includes(norm))
  if (candidates.length === 0) return undefined
  candidates.sort((a, b) => {
    const an = normalize(a.name)
    const bn = normalize(b.name)
    const aStarts = an.startsWith(norm) ? 0 : 1
    const bStarts = bn.startsWith(norm) ? 0 : 1
    if (aStarts !== bStarts) return aStarts - bStarts
    return an.length - bn.length
  })
  return candidates[0]
}

export function isValidCode(query: string, kind: CodeKind = "any"): { ok: boolean; matched?: Country } {
  if (!query) return { ok: false }
  const upper = query.trim().toUpperCase()
  const idx = index()
  if ((kind === "alpha2" || kind === "any") && /^[A-Z]{2}$/.test(upper)) {
    const c = idx.byAlpha2.get(upper)
    if (c) return { ok: true, matched: c }
  }
  if ((kind === "alpha3" || kind === "any") && /^[A-Z]{3}$/.test(upper)) {
    const c = idx.byAlpha3.get(upper)
    if (c) return { ok: true, matched: c }
  }
  if ((kind === "numeric" || kind === "any") && /^[0-9]{1,3}$/.test(upper)) {
    const padded = upper.padStart(3, "0")
    const c = idx.byNumeric.get(padded)
    if (c) return { ok: true, matched: c }
  }
  return { ok: false }
}

export function listCountries(opts?: { region?: Region; subregion?: string }): Country[] {
  const idx = index()
  const sub = opts?.subregion ? normalize(opts.subregion) : undefined
  return idx.countries.filter((c) => {
    if (opts?.region && c.region !== opts.region) return false
    if (sub && !normalize(c.subregion).includes(sub)) return false
    return true
  })
}

function formatCountry(c: Country): string {
  return `${c.flag} ${c.alpha2} / ${c.alpha3} / ${c.numeric} - ${c.name} (${c.region}${c.subregion ? `, ${c.subregion}` : ""})${c.calling_code ? ` ${c.calling_code}` : ""}`.trim()
}

export const CountryTool = Tool.define(
  "country",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, _ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const action = params.action
          const limit = params.limit ?? DEFAULT_LIMIT

          if (action === "info") {
            const idx = index()
            const regions = Array.from(new Set(idx.countries.map((c) => c.region))).sort()
            const subregions = Array.from(new Set(idx.countries.map((c) => c.subregion))).sort()
            return done({
              title: `country: ${idx.countries.length} entries`,
              metadata: { action, total: idx.countries.length },
              output: [
                `ISO 3166-1 entries: ${idx.countries.length}`,
                `Regions: ${regions.join(", ")}`,
                `Subregions: ${subregions.length}`,
              ].join("\n"),
            })
          }

          if (action === "lookup") {
            if (!params.query) throw new Error("country.lookup: query is required")
            const matched = lookupCountry(params.query)
            if (!matched) {
              return done({
                title: `country: no match for ${params.query.slice(0, 40)}`,
                metadata: { action, query: params.query, matches: 0 },
                output: `No country matched query: ${params.query}`,
              })
            }
            return done({
              title: `country: ${matched.flag} ${matched.alpha2} ${matched.name}`,
              metadata: { action, query: params.query, matches: 1, matched },
              output: formatCountry(matched),
            })
          }

          if (action === "validate") {
            if (!params.query) throw new Error("country.validate: query is required")
            const { ok, matched } = isValidCode(params.query, params.code_kind ?? "any")
            return done({
              title: ok ? `country: valid ${matched!.alpha2}` : `country: invalid ${params.query.slice(0, 20)}`,
              metadata: { action, query: params.query, code_kind: params.code_kind ?? "any", ok, matched },
              output: ok ? `valid (${formatCountry(matched!)})` : `invalid: ${params.query}`,
            })
          }

          if (action === "list") {
            const filtered = listCountries({ region: params.region, subregion: params.subregion })
            const total = filtered.length
            const sliced = filtered.slice(0, limit)
            const lines = sliced.map(formatCountry)
            return done({
              title: `country list: ${sliced.length}${total > sliced.length ? ` of ${total}` : ""}`,
              metadata: {
                action,
                total,
                matches: sliced.length,
                region: params.region,
                subregion: params.subregion,
                countries: sliced,
              },
              output: lines.join("\n") + (total > sliced.length ? `\n... +${total - sliced.length} more` : ""),
            })
          }

          throw new Error(`country: unknown action ${action satisfies never}`)
        }),
    }
  }),
)

export const __testing = {
  flagFromAlpha2,
  alpha2FromFlag,
  normalize,
  index,
  ALIASES,
  ROWS,
}
