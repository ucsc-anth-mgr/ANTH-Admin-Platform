// ============================================================
// Countries.gs — UN M49 country list grouped by continent
// ============================================================
// Auto-generated from the UN M49 standard (Standard Country or
// Area Codes for Statistical Use). Continent is the M49 top-level
// region. Used by the Thesis module for the grouped country picker
// and to DERIVE a country's continent (never stored on the record).
//
// This is reference data, not user config: it is a closed, controlled
// list (students pick, never add). Update only if the UN standard changes.
// ============================================================

const Countries = (() => {

  // Continent display order for the grouped dropdown.
  const CONTINENT_ORDER = ["Africa", "Americas", "Asia", "Europe", "Oceania", "Antarctica"];

  // Continent -> [country names], alphabetical within each group.
  const BY_CONTINENT = {
    "Africa": ["Algeria", "Angola", "Benin", "Botswana", "British Indian Ocean Territory", "Burkina Faso", "Burundi", "Cabo Verde", "Cameroon", "Central African Republic", "Chad", "Comoros", "Congo", "Côte d’Ivoire", "Democratic Republic of the Congo", "Djibouti", "Egypt", "Equatorial Guinea", "Eritrea", "Eswatini", "Ethiopia", "French Southern Territories", "Gabon", "Gambia", "Ghana", "Guinea", "Guinea-Bissau", "Kenya", "Lesotho", "Liberia", "Libya", "Madagascar", "Malawi", "Mali", "Mauritania", "Mauritius", "Mayotte", "Morocco", "Mozambique", "Namibia", "Niger", "Nigeria", "Rwanda", "Réunion", "Saint Helena", "Sao Tome and Principe", "Senegal", "Seychelles", "Sierra Leone", "Somalia", "South Africa", "South Sudan", "Sudan", "Togo", "Tunisia", "Uganda", "United Republic of Tanzania", "Western Sahara", "Zambia", "Zimbabwe"],
    "Americas": ["Anguilla", "Antigua and Barbuda", "Argentina", "Aruba", "Bahamas", "Barbados", "Belize", "Bermuda", "Bolivia (Plurinational State of)", "Bonaire, Sint Eustatius and Saba", "Bouvet Island", "Brazil", "British Virgin Islands", "Canada", "Cayman Islands", "Chile", "Colombia", "Costa Rica", "Cuba", "Curaçao", "Dominica", "Dominican Republic", "Ecuador", "El Salvador", "Falkland Islands (Malvinas)", "French Guiana", "Greenland", "Grenada", "Guadeloupe", "Guatemala", "Guyana", "Haiti", "Honduras", "Jamaica", "Martinique", "Mexico", "Montserrat", "Nicaragua", "Panama", "Paraguay", "Peru", "Puerto Rico", "Saint Barthélemy", "Saint Kitts and Nevis", "Saint Lucia", "Saint Martin (French Part)", "Saint Pierre and Miquelon", "Saint Vincent and the Grenadines", "Sint Maarten (Dutch part)", "South Georgia and the South Sandwich Islands", "Suriname", "Trinidad and Tobago", "Turks and Caicos Islands", "United States Virgin Islands", "United States of America", "Uruguay", "Venezuela (Bolivarian Republic of)"],
    "Asia": ["Afghanistan", "Armenia", "Azerbaijan", "Bahrain", "Bangladesh", "Bhutan", "Brunei Darussalam", "Cambodia", "China", "China, Hong Kong Special Administrative Region", "China, Macao Special Administrative Region", "Cyprus", "Democratic People's Republic of Korea", "Georgia", "India", "Indonesia", "Iran (Islamic Republic of)", "Iraq", "Israel", "Japan", "Jordan", "Kazakhstan", "Kuwait", "Kyrgyzstan", "Lao People's Democratic Republic", "Lebanon", "Malaysia", "Maldives", "Mongolia", "Myanmar", "Nepal", "Oman", "Pakistan", "Philippines", "Qatar", "Republic of Korea", "Saudi Arabia", "Singapore", "Sri Lanka", "State of Palestine", "Syrian Arab Republic", "Tajikistan", "Thailand", "Timor-Leste", "Turkmenistan", "Türkiye", "United Arab Emirates", "Uzbekistan", "Viet Nam", "Yemen"],
    "Europe": ["Albania", "Andorra", "Austria", "Belarus", "Belgium", "Bosnia and Herzegovina", "Bulgaria", "Croatia", "Czechia", "Denmark", "Estonia", "Faroe Islands", "Finland", "France", "Germany", "Gibraltar", "Greece", "Guernsey", "Holy See", "Hungary", "Iceland", "Ireland", "Isle of Man", "Italy", "Jersey", "Latvia", "Liechtenstein", "Lithuania", "Luxembourg", "Malta", "Monaco", "Montenegro", "Netherlands (Kingdom of the)", "North Macedonia", "Norway", "Poland", "Portugal", "Republic of Moldova", "Romania", "Russian Federation", "San Marino", "Serbia", "Slovakia", "Slovenia", "Spain", "Svalbard and Jan Mayen Islands", "Sweden", "Switzerland", "Ukraine", "United Kingdom of Great Britain and Northern Ireland", "Åland Islands"],
    "Oceania": ["American Samoa", "Australia", "Christmas Island", "Cocos (Keeling) Islands", "Cook Islands", "Fiji", "French Polynesia", "Guam", "Heard Island and McDonald Islands", "Kiribati", "Marshall Islands", "Micronesia (Federated States of)", "Nauru", "New Caledonia", "New Zealand", "Niue", "Norfolk Island", "Northern Mariana Islands", "Palau", "Papua New Guinea", "Pitcairn", "Samoa", "Solomon Islands", "Tokelau", "Tonga", "Tuvalu", "United States Minor Outlying Islands", "Vanuatu", "Wallis and Futuna Islands"],
    "Antarctica": ["Antarctica"],
  };

  // Reverse index country -> continent, built once.
  const _continentOf = {};
  CONTINENT_ORDER.forEach(function (cont) {
    (BY_CONTINENT[cont] || []).forEach(function (name) { _continentOf[name] = cont; });
  });

  /** Grouped list for the UI: [{ continent, countries:[name,...] }]. */
  function grouped() {
    return CONTINENT_ORDER.map(function (cont) {
      return { continent: cont, countries: BY_CONTINENT[cont] || [] };
    });
  }

  /** True if `name` is a valid country in the list. */
  function isValid(name) { return Object.prototype.hasOwnProperty.call(_continentOf, String(name || '').trim()); }

  /** Continent for a country name, or '' if unknown. Derived, never stored. */
  function continentOf(name) { return _continentOf[String(name || '').trim()] || ''; }

  return { grouped: grouped, isValid: isValid, continentOf: continentOf };

})();