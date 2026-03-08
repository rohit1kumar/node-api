import http from "k6/http";
import { check, sleep } from "k6";

const BASE = __ENV.BASE || "https://api.roht.me";

export const options = {
    vus: 50, // virtual users
    duration: "500s", // test duration
};

export default function () {

    // Health
    let health = http.get(`${BASE}/health`);
    check(health, {
        "health status 200": (r) => r.status === 200,
    });

    // POST cache
    let payload = JSON.stringify({
        key: "user:1",
        value: { name: "Alice", id: 1 },
        ttl: 60
    });

    let params = { headers: { "Content-Type": "application/json" } };

    let postRes = http.post(`${BASE}/cache`, payload, params);
    check(postRes, {
        "cache created": (r) => r.status === 200 || r.status === 201,
    });

    // GET cache
    let getRes = http.get(`${BASE}/cache/user:1`);
    check(getRes, {
        "cache fetched": (r) => r.status === 200,
    });

    // DELETE cache
    let delRes = http.del(`${BASE}/cache/user:1`);
    check(delRes, {
        "cache deleted": (r) => r.status === 200,
    });

    sleep(1);
}