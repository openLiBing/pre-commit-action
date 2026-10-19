const AdmZip = require("adm-zip");

const zip = new AdmZip();
zip.addLocalFile("./README.md");
zip.addLocalFile("./action.yml");
zip.addLocalFolder("./dist", "./dist");
zip.writeZip("./pre-commit-action.zip");

console.log("ZIP package created: pre-commit-action.zip");
