const data = {
  region: "region_5",
  provinces: [
    { id: 0, name: "albay" },
    { id: 1, name: "camarines norte" },
    { id: 2, name: "camarines sur" },
    { id: 3, name: "catanduanes" },
    { id: 4, name: "masbate" },
    { id: 5, name: "sorsogon" },
  ],
  municipalities: [
    // Albay (provinceId: 0)
    { id: 0, provinceId: 0, districtId: 1, name: "tabaco city" },
    { id: 1, provinceId: 0, districtId: 2, name: "legazpi city",  noOfBrgy: 70},
    { id: 2, provinceId: 0, districtId: 3, name: "ligao city"},
    { id: 3, provinceId: 0, districtId: 2, name: "daraga" },

    // Camarines Norte (provinceId: 1)
    { id: 4, provinceId: 1, districtId: 2, name: "daet" },
    { id: 5, provinceId: 1, districtId: 1, name: "labo" },
    { id: 6, provinceId: 1, districtId: 2, name: "mercedes" },

    // Camarines Sur (provinceId: 2)
    { id: 7, provinceId: 2, districtId: 3, name: "pili" },
    { id: 8, provinceId: 2, districtId: 3, name: "naga city" }, // Independent Component
    { id: 9, provinceId: 2, districtId: 5, name: "iriga city" },
    { id: 10, provinceId: 2, districtId: 4, name: "goa" },

    // Catanduanes (provinceId: 3)
    { id: 11, provinceId: 3, districtId: 1, name: "virac" },
    { id: 12, provinceId: 3, districtId: 1, name: "viga" },

    // Masbate (provinceId: 4)
    { id: 13, provinceId: 4, districtId: 2, name: "masbate city" },
    { id: 14, provinceId: 4, districtId: 1, name: "san pascual" },

    // Sorsogon (provinceId: 5)
    { id: 15, provinceId: 5, districtId: 1, name: "sorsogon city" },
    { id: 16, provinceId: 5, districtId: 2, name: "bulan" },
    { id: 17, provinceId: 5, districtId: 1, name: "casiguran" }
  ],
};

module.exports = data;