// Small hand-made samples shaped exactly like the real public files (structure checked against downloads on 2026-10-25).
// Names are real public listings or plain inventions; the ids are made up. Tests only.

const NUL = "-0- "; // OFAC writes an empty field as "-0- " (with the trailing space)
const sdnRow = (id: number, name: string, type: string, program: string, remarks = NUL, flag = NUL) =>
  `${id},"${name}",${type === "" ? NUL : `"${type}"`},"${program}",${NUL},${NUL},${NUL},${NUL},${NUL},${flag === NUL ? NUL : `"${flag}"`},${NUL},${remarks === NUL ? NUL : `"${remarks}"`}`;

// CRLF line ends and a trailing Ctrl-Z byte, as in the real file.
export const SDN_CSV = [
  sdnRow(90001, "BIN LADIN, Usama bin Muhammad bin Awad", "individual", "SDGT", "DOB 1957; POB Saudi Arabia"),
  sdnRow(90002, "AL ZAWAHIRI, Dr. Ayman", "individual", "SDGT", "DOB 19 Jun 1951; POB Giza, Egypt"),
  sdnRow(90003, "BANK MELLI IRAN", "", "IRAN] [NPWMD"),
  sdnRow(90004, "AEROCARIBBEAN AIRLINES", "", "CUBA"),
  sdnRow(90005, "EBANO", "vessel", "CUBA", "Vessel Registration Identification IMO 7406784", "Panama"),
  sdnRow(90006, "ABU SAYYAF GROUP", "", "FTO] [SDGT"),
  sdnRow(90007, "HASSAN ALI MAJEED TRADING COMPANY", "", "IRAN"),
].join("\r\n") + "\r\n\x1a";

export const ALT_CSV = [
  `90001,50001,"aka","BIN LADEN, Osama",${NUL}`,
  `90002,50002,"aka","AL-ZAWAHIRI, Ayman",${NUL}`,
  `90003,50003,"aka","MELLI BANK",${NUL}`,
  `90004,50004,"aka","AERO-CARIBBEAN",${NUL}`,
  `99999,50005,"aka","ORPHAN ALIAS OF A PARTY NOT ON THE LIST",${NUL}`,
].join("\r\n") + "\r\n\x1a";

export const UN_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<CONSOLIDATED_LIST xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="https://www.un.org/sc/resources/sc-sanctions.xsd" dateGenerated="2026-10-24T23:00:07.335Z">
  <INDIVIDUALS>
    <INDIVIDUAL>
      <DATAID>7000001</DATAID>
      <VERSIONNUM>1</VERSIONNUM>
      <FIRST_NAME>SADDAM</FIRST_NAME>
      <SECOND_NAME>HUSSEIN</SECOND_NAME>
      <THIRD_NAME>AL-TIKRITI</THIRD_NAME>
      <UN_LIST_TYPE>Iraq</UN_LIST_TYPE>
      <REFERENCE_NUMBER>IQi.001</REFERENCE_NUMBER>
      <LISTED_ON>2003-06-27</LISTED_ON>
      <COMMENTS1>Former president &amp; &quot;leader&quot;.</COMMENTS1>
      <NATIONALITY>
        <VALUE>Iraq</VALUE>
      </NATIONALITY>
      <INDIVIDUAL_ALIAS>
        <QUALITY>Good</QUALITY>
        <ALIAS_NAME>ABU ALI</ALIAS_NAME>
      </INDIVIDUAL_ALIAS>
      <INDIVIDUAL_ALIAS>
        <QUALITY/>
        <ALIAS_NAME/>
      </INDIVIDUAL_ALIAS>
      <INDIVIDUAL_ADDRESS>
        <COUNTRY>Iraq</COUNTRY>
      </INDIVIDUAL_ADDRESS>
    </INDIVIDUAL>
    <INDIVIDUAL>
      <DATAID>7000002</DATAID>
      <FIRST_NAME>FRANK KAKOLELE</FIRST_NAME>
      <SECOND_NAME>BWAMBALE</SECOND_NAME>
      <UN_LIST_TYPE>DRC</UN_LIST_TYPE>
      <REFERENCE_NUMBER>CDi.002</REFERENCE_NUMBER>
      <INDIVIDUAL_ALIAS>
        <QUALITY>Good</QUALITY>
        <ALIAS_NAME>FRANK KAKORERE</ALIAS_NAME>
      </INDIVIDUAL_ALIAS>
      <INDIVIDUAL_ADDRESS>
        <CITY>Kinshasa</CITY>
        <COUNTRY>Democratic Republic of the Congo</COUNTRY>
      </INDIVIDUAL_ADDRESS>
    </INDIVIDUAL>
  </INDIVIDUALS>
  <ENTITIES>
    <ENTITY>
      <DATAID>7000003</DATAID>
      <VERSIONNUM>1</VERSIONNUM>
      <FIRST_NAME>ADF</FIRST_NAME>
      <UN_LIST_TYPE>DRC</UN_LIST_TYPE>
      <REFERENCE_NUMBER>CDe.001</REFERENCE_NUMBER>
      <ENTITY_ALIAS>
        <QUALITY>a.k.a.</QUALITY>
        <ALIAS_NAME>Allied Democratic Forces</ALIAS_NAME>
      </ENTITY_ALIAS>
      <ENTITY_ALIAS>
        <QUALITY>f.k.a.</QUALITY>
        <ALIAS_NAME>ADF/NALU</ALIAS_NAME>
      </ENTITY_ALIAS>
      <ENTITY_ADDRESS>
        <STATE_PROVINCE>North Kivu </STATE_PROVINCE>
        <COUNTRY>Democratic Republic of the Congo</COUNTRY>
      </ENTITY_ADDRESS>
    </ENTITY>
  </ENTITIES>
</CONSOLIDATED_LIST>
`;

export const EU_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<export xmlns="http://eu.europa.ec/fpi/fsd/export" generationDate="2026-10-23T17:05:43.888+02:00" globalFileId="185833">
    <sanctionEntity designationDetails="" unitedNationId="" euReferenceNumber="EU.39.56" logicalId="20">
        <remark>Saddam's second son</remark>
        <regulation regulationType="regulation" organisationType="commission" publicationDate="2003-07-08" entryIntoForceDate="2003-07-07" numberTitle="1210/2003 (OJ L169)" programme="IRQ" logicalId="348">
            <publicationUrl>http://eur-lex.europa.eu/LexUriServ/LexUriServ.do?uri=OJ:L:2003:169:0006:0023:EN:PDF</publicationUrl>
        </regulation>
        <subjectType code="person" classificationCode="P"/>
        <nameAlias firstName="Qoussaï" middleName="Saddam" lastName="Hussein Al-Tikriti" wholeName="Qoussaï Saddam Hussein Al-Tikriti" function="" title="" nameLanguage="FR" strong="true" regulationLanguage="en" logicalId="381">
            <regulationSummary regulationType="regulation" publicationDate="2003-07-08" numberTitle="1210/2003 (OJ L169)"/>
        </nameAlias>
        <nameAlias firstName="Qusay" middleName="Saddam" lastName="Hussein Al-Tikriti" wholeName="Qusay Saddam Hussein Al-Tikriti" function="" gender="M" title="" nameLanguage="" strong="true" regulationLanguage="en" logicalId="382">
            <regulationSummary regulationType="regulation" publicationDate="2003-07-08" numberTitle="1210/2003 (OJ L169)"/>
        </nameAlias>
        <nameAlias firstName="" middleName="" lastName="" wholeName="" function="" title="" nameLanguage="" strong="false" regulationLanguage="en" logicalId="383"/>
        <citizenship region="" countryIso2Code="IQ" countryDescription="IRAQ" regulationLanguage="en" logicalId="2">
            <regulationSummary regulationType="regulation" publicationDate="2003-07-08" numberTitle="1210/2003 (OJ L169)"/>
        </citizenship>
        <birthdate circa="false" calendarType="GREGORIAN" city="Baghdad" zipCode="" year="1965" region="" place="" countryIso2Code="00" countryDescription="UNKNOWN" regulationLanguage="en" logicalId="19"/>
    </sanctionEntity>
    <sanctionEntity designationDate="2002-06-18" designationDetails="" unitedNationId="" euReferenceNumber="EU.3502.46" logicalId="201">
        <regulation regulationType="amendment" organisationType="council" publicationDate="2025-01-31" entryIntoForceDate="2025-02-01" numberTitle="2025/206 (L 202500206)" programme="TERR" logicalId="207667">
            <publicationUrl>https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=OJ:L_202500206</publicationUrl>
        </regulation>
        <subjectType code="enterprise" classificationCode="E"/>
        <nameAlias firstName="" middleName="" lastName="" wholeName="Arab Revolutionary Brigades" function="" title="" nameLanguage="EN" strong="true" regulationLanguage="en" logicalId="314"/>
        <nameAlias firstName="" middleName="" lastName="" wholeName="Black September" function="" title="" nameLanguage="EN" strong="true" regulationLanguage="en" logicalId="315"/>
        <address city="Tripoli" street="" postCode="" countryIso2Code="LY" countryDescription="LIBYA" regulationLanguage="en" logicalId="900"/>
    </sanctionEntity>
</export>
`;
