const request = require('supertest');
const app = require('../app');

describe('GET /', function () {
    it('Return default top page', function (done) {
        request(app)
            .get('/')
            .expect(200, done);
    });
});

describe('GET /users', function () {
    it('`/users` method created by default', function (done) {
        request(app)
            .get('/users')
            .expect(200, done);
    });
});
