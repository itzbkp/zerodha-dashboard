const server = require("./api/server");
require("dotenv").config({ quiet: true });

const PORT = process.env.PORT;

server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});