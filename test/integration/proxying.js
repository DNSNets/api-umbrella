'use strict';

require('../test_helper');

var _ = require('lodash'),
    async = require('async'),
    Curler = require('curler').Curler,
    Factory = require('factory-lady'),
    fs = require('fs'),
    http = require('http'),
    randomstring = require('randomstring'),
    request = require('request'),
    stk = require('stream-tk'),
    temp = require('temp'),
    zlib = require('zlib');

temp.track();

describe('proxying', function() {
  beforeEach(function(done) {
    Factory.create('api_user', { settings: { rate_limit_mode: 'unlimited' } }, function(user) {
      this.apiKey = user.api_key;
      done();
    }.bind(this));
  });

  describe('streaming', function() {
    // TODO: nginx doesn't support chunked request streaming:
    // http://forum.nginx.org/read.php?2,243073,243074#msg-243074
    //
    // Revisit this under HAProxy 1.5
    xit('streams requests', function(done) {
      var req = http.request({
        host: 'localhost',
        port: 9080,
        //port: 9444,
        path: '/receive_chunks?api_key=' + this.apiKey,
        method: 'POST',
        headers: {
          'Transfer-Encoding': 'chunked',
        },
      }, function(response) {
        var body = '';
        response.on('data', function(chunk) {
          body += chunk.toString();
        });

        response.on('end', function() {
          var data = JSON.parse(body);
          data.chunks.should.eql([
            'hello',
            'greetings',
            'goodbye',
          ]);

          data.chunkTimeGaps.length.should.eql(2);
          data.chunkTimeGaps[0].should.be.greaterThan(400);
          data.chunkTimeGaps[1].should.be.greaterThan(400);

          data.request_encoding.should.eql('chunked');

          done();
        });
      });

      req.setNoDelay(true);

      req.write('hello');
      setTimeout(function() {
        req.write('greetings');
        setTimeout(function() {
          req.write('goodbye');
          req.end();
        }, 500);
      }, 500);
    });

    it('streams responses', function(done) {
      var options = {
        url: 'http://localhost:9080/chunked?api_key=' + this.apiKey,
      };

      shared.chunkedRequestDetails(options, function(response, data) {
        data.stringChunks.should.eql([
          'hello',
          'salutations',
          'goodbye',
        ]);

        data.chunkTimeGaps.length.should.eql(2);
        data.chunkTimeGaps[0].should.be.greaterThan(400);
        data.chunkTimeGaps[1].should.be.greaterThan(400);

        response.headers['transfer-encoding'].should.eql('chunked');

        done();
      });
    });
  });

  it('accepts large uploads', function(done) {
    this.timeout(15000);

    var size = 20 * 1024 * 1024;
    var random = stk.createRandom('read', size);
    var stream = temp.createWriteStream();
    random.pipe(stream);
    stream.on('finish', function() {
      var req = request.post('http://localhost:9080/upload?api_key=' + this.apiKey, function(error, response, body) {
        response.statusCode.should.eql(200);
        var data = JSON.parse(body);
        data.upload_size.should.eql(size);
        done();
      });

      var form = req.form();
      form.append('upload', fs.createReadStream(stream.path));
    }.bind(this));
  });

  describe('header size', function() {
    function requestOfHeaderSize(options, callback) {
      var headers = {
        'X-Api-Key': options.apiKey,
        'Host': 'localhost:9080',
        'Connection': 'close',
      };

      var headerLineExtraLength = ': \r\n'.length;

      var rawRequestLength = 'GET /info/ HTTP/1.1\r\n'.length;
      for(var key in headers) {
        rawRequestLength += key.length;
        rawRequestLength += headers[key].length;
        rawRequestLength += headerLineExtraLength;
      }

      var index = 5;
      while(rawRequestLength < options.size) {
        if(index > options.numHeaders) {
          break;
        }

        var headerName = 'X-Test' + index;
        headers[headerName] = randomstring.generate(options.lineLength - headerName.length - headerLineExtraLength);

        rawRequestLength += headerName.length;
        rawRequestLength += headers[headerName].length;
        rawRequestLength += headerLineExtraLength;

        var overSizeLimitBy = rawRequestLength - options.size;
        if(overSizeLimitBy > 0) {
          headers[headerName] = headers[headerName].substring(0, headers[headerName].length - overSizeLimitBy);
        }

        index++;
      }

      request.get('http://localhost:9080/info/', { headers: headers }, function(error, response, body) {
        callback(response, body);
      });
    }

    it('allows a total header size of up to 32KB-ish', function(done) {
      requestOfHeaderSize({ size: 32000, lineLength: 4048, apiKey: this.apiKey }, function(response, body) {
        response.statusCode.should.eql(200);
        body.should.contain('"x-test5":');
        done();
      });
    });

    it('returns 400 bad request when the total header size exceeds 32KB-ish', function(done) {
      requestOfHeaderSize({ size: 34000, lineLength: 4048, apiKey: this.apiKey }, function(response) {
        response.statusCode.should.eql(400);
        done();
      });
    });

    it('allows an individual header to be 8KB', function(done) {
      requestOfHeaderSize({ size: 12000, lineLength: 8192, apiKey: this.apiKey }, function(response, body) {
        response.statusCode.should.eql(200);

        var data = JSON.parse(body);
        var headerLength = data.headers['x-test5'].length;
        headerLength += 'x-test5: \r\n'.length;
        headerLength.should.eql(8192);

        done();
      });
    });

    it('returns 400 bad request when an individual header exceeds 8KB', function(done) {
      requestOfHeaderSize({ size: 12000, lineLength: 8193, apiKey: this.apiKey }, function(response) {
        response.statusCode.should.eql(400);
        done();
      });
    });

    // Varnish has a limit on the number of HTTP header lines. This is 64 lines
    // by default. But because our stack adds a variety of extra headers (eg,
    // x-forwarded-for, x-api-umbrella-key, etc), by the time the request gets
    // to Varnish, it means we can really only pass 53 lines in as the original
    // request.
    it('allows up to 53 header lines (really 64 lines at the Varnish layer)', function(done) {
      requestOfHeaderSize({ size: 12000, lineLength: 24, numHeaders: 53, apiKey: this.apiKey }, function(response, body) {
        response.statusCode.should.eql(200);
        body.should.contain('"x-test53":');
        body.should.not.contain('"x-test54":');
        done();
      });
    });

    it('returns 400 request entity too large when the number of header lines exceeds 53 (really 64 lines at the Varnish layer)', function(done) {
      requestOfHeaderSize({ size: 12000, lineLength: 24, numHeaders: 54, apiKey: this.apiKey }, function(response) {
        response.statusCode.should.eql(400);
        done();
      });
    });
  });

  // Ensure basic HTTP requests of all HTTP methods work with the entire stack
  // in place.
  //
  // This mainly stems from nodejs breaking OPTIONS requests without bodies
  // and Varnish really not liking it (this should be fixed in NodeJS v0.11):
  // https://github.com/joyent/node/pull/7725
  //
  // Also, this is a little tricky to test in node.js, since all OPTIONS
  // requests originating from node's http library currently add the chunked
  // headers (due to above issue). So we'll drop to a curl library to make
  // these test requests.
  describe('all http methods work', function() {
    describe('without request body', function() {
      ['GET', 'HEAD', 'DELETE', 'OPTIONS'].forEach(function(method) {
        it('successfully makes ' + method + ' requests', function(done) {
          var curl = new Curler();
          curl.request({
            method: method,
            url: 'http://localhost:9080/info/?api_key=' + this.apiKey,
          }, function(error, response) {
            response.statusCode.should.eql(200);
            response.headers['x-received-method'].should.eql(method);
            done();
          });
        });
      });
    });

    describe('with request body', function() {
      ['POST', 'PUT', 'OPTIONS', 'PATCH'].forEach(function(method) {
        it('successfully makes ' + method + ' requests', function(done) {
          var curl = new Curler();
          curl.request({
            method: method,
            url: 'http://localhost:9080/info/?api_key=' + this.apiKey,
            headers: {
              'Transfer-Encoding': 'chunked',
              'Content-Length': '4',
            },
            data: 'test',
          }, function(error, response) {
            response.statusCode.should.eql(200);
            response.headers['x-received-method'].should.eql(method);
            done();
          });
        });
      });
    });

    describe('disallowed', function() {
      it('returns 405 not allowed error for TRACE requests', function(done) {
        var curl = new Curler();
        curl.request({
          method: 'TRACE',
          url: 'http://localhost:9080/info/?api_key=' + this.apiKey,
        }, function(error, response) {
          response.statusCode.should.eql(405);
          done();
        });
      });
    });
  });

  describe('server-side keep alive', function() {
    it('keeps 10 idle keepalive connections opened to the backend', function(done) {
      this.timeout(3000);

      // Open a bunch of concurrent connections first, and then inspect the
      // number of number of connections still active afterwards.
      var options = { agentOptions: { maxSockets: 150 } };
      async.times(50, function(index, callback) {
        request.get('http://localhost:9080/keepalive9445/connections?api_key=' + this.apiKey, options, function(error, response) {
          response.statusCode.should.eql(200);
          callback(error);
        });
      }.bind(this), function() {
        setTimeout(function() {
          request.get('http://localhost:9080/keepalive9445/connections?api_key=' + this.apiKey, function(error, response, body) {
            response.statusCode.should.eql(200);

            var data = JSON.parse(body);
            data.start.connections.should.eql(10);
            data.start.requests.should.eql(1);
            data.end.connections.should.eql(10);
            data.end.requests.should.eql(1);

            done();
          });
        }.bind(this), 1000);
      }.bind(this));
    });

    it('allows the number of idle backend keepalive connections to be configured', function(done) {
      this.timeout(3000);

      // Open a bunch of concurrent connections first, and then inspect the
      // number of number of connections still active afterwards.
      var options = { agentOptions: { maxSockets: 150 } };
      async.times(50, function(index, callback) {
        request.get('http://localhost:9080/keepalive9446/connections?api_key=' + this.apiKey, options, function(error, response) {
          response.statusCode.should.eql(200);
          callback(error);
        });
      }.bind(this), function() {
        setTimeout(function() {
          request.get('http://localhost:9080/keepalive9446/connections?api_key=' + this.apiKey, function(error, response, body) {
            response.statusCode.should.eql(200);

            var data = JSON.parse(body);
            data.start.connections.should.eql(6);
            data.start.requests.should.eql(1);
            data.end.connections.should.eql(6);
            data.end.requests.should.eql(1);

            done();
          });
        }.bind(this), 1000);
      }.bind(this));
    });

    it('allows the number of concurrent connections to execeed the number of keepalive connections', function(done) {
      this.timeout(5000);

      var maxConnections = 0;
      var maxRequests = 0;

      var options = { agentOptions: { maxSockets: 200 } };
      async.times(200, function(index, callback) {
        request.get('http://localhost:9080/keepalive9447/connections?api_key=' + this.apiKey, options, function(error, response, body) {
          response.statusCode.should.eql(200);

          var data = JSON.parse(body);

          if(data.start.connections > maxConnections) {
            maxConnections = data.start.connections;
          }

          if(data.start.requests > maxRequests) {
            maxRequests = data.start.requests;
          }

          callback(error);
        });
      }.bind(this), function() {
        // We sent 200 concurrent requests, but the number of concurrent
        // requests to the backend will likely be lower, since we're testing
        // the full stack, and the requests have to go through multiple layers
        // (the gatekeeper, caching, etc) which may lower absolute concurrency.
        // But all we're really trying to test here is that this does increase
        // above the 10 keepalived connections.
        maxRequests.should.be.greaterThan(20);
        maxConnections.should.be.greaterThan(20);

        done();
      });
    });
  });

  describe('gzip', function() {
    describe('backend returning non-gzipped content', function() {
      it('gzips the response when the content length is greather than or equal to 1000', function(done) {
        var options = { gzip: true };
        request.get('http://localhost:9080/compressible/1000?api_key=' + this.apiKey, options, function(error, response, body) {
          response.statusCode.should.eql(200);
          response.headers['content-encoding'].should.eql('gzip');
          body.toString().length.should.eql(1000);
          done();
        });
      });

      it('does not gzip the response when the content length is less than 1000', function(done) {
        var options = { gzip: true };
        request.get('http://localhost:9080/compressible/999?api_key=' + this.apiKey, options, function(error, response, body) {
          response.statusCode.should.eql(200);
          should.not.exist(response.headers['content-encoding']);
          body.toString().length.should.eql(999);
          done();
        });
      });

      it('gzips chunked responses of any size', function(done) {
        var options = { gzip: true };
        request.get('http://localhost:9080/compressible-delayed-chunked/5?api_key=' + this.apiKey, options, function(error, response, body) {
          response.statusCode.should.eql(200);
          response.headers['content-encoding'].should.eql('gzip');
          body.toString().length.should.eql(15);
          done();
        });
      });

      it('returns unzipped response when unsupported', function(done) {
        var options = { gzip: false };
        request.get('http://localhost:9080/compressible/1000?api_key=' + this.apiKey, options, function(error, response, body) {
          response.statusCode.should.eql(200);
          should.not.exist(response.headers['content-encoding']);
          body.toString().length.should.eql(1000);
          done();
        });
      });
    });

    describe('backend returning pre-gzipped content', function() {
      it('returns gzipped response when supported', function(done) {
        var options = { gzip: true };
        request.get('http://localhost:9080/compressible-pre-gzip?api_key=' + this.apiKey, options, function(error, response, body) {
          response.statusCode.should.eql(200);
          response.headers['content-encoding'].should.eql('gzip');
          body.toString().should.eql('Hello Small World');
          done();
        });
      });

      it('returns unzipped response when unsupported', function(done) {
        var options = { gzip: false };
        request.get('http://localhost:9080/compressible-pre-gzip?api_key=' + this.apiKey, options, function(error, response, body) {
          response.statusCode.should.eql(200);
          should.not.exist(response.headers['content-encoding']);
          body.toString().should.eql('Hello Small World');
          done();
        });
      });
    });

    describe('compressible response types', function() {
      [
        'application/atom+xml',
        'application/javascript',
        'application/json',
        'application/rss+xml',
        'application/x-javascript',
        'application/xml',
        'text/css',
        'text/csv',
        'text/html',
        'text/javascript',
        'text/plain',
        'text/xml',
      ].forEach(function(mime) {
        it('returns gzip response for "' + mime + '" content type', function(done) {
          var options = {
            url: 'http://localhost:9080/compressible/1000',
            qs: {
              api_key: this.apiKey,
              content_type: mime,
            },
            gzip: true,
          };

          request(options, function(error, response, body) {
            response.statusCode.should.eql(200);
            response.headers['content-encoding'].should.eql('gzip');
            body.toString().length.should.eql(1000);
            done();
          });
        });
      });
    });

    describe('non-compressible response types', function() {
      [
        '',
        'image/png',
        'application/octet-stream',
        'application/x-perl',
        'application/x-whatever-unknown',
      ].forEach(function(mime) {
        it('returns non-gzip response for "' + mime + '" content type', function(done) {
          var options = {
            url: 'http://localhost:9080/compressible/1000',
            qs: {
              api_key: this.apiKey,
              content_type: mime,
            },
            gzip: true,
          };

          request(options, function(error, response, body) {
            response.statusCode.should.eql(200);
            should.not.exist(response.headers['content-encoding']);
            body.toString().length.should.eql(1000);
            done();
          });
        });
      });
    });

    describe('response streaming', function() {
      it('streams back small chunks directly as gzipped chunks', function(done) {
        var options = {
          url: 'http://localhost:9080/compressible-delayed-chunked/5?api_key=' + this.apiKey,
          gzip: true,
        };

        shared.chunkedRequestDetails(options, function(response, data) {
          var buffer = Buffer.concat(data.chunks);
          zlib.gunzip(buffer, function(error, decodedBody) {
            should.not.exist(error);

            response.headers['content-encoding'].should.eql('gzip');
            response.headers['transfer-encoding'].should.eql('chunked');
            decodedBody.toString().length.should.eql(15);

            // Ensure we have at least 3 chunks (it may be 4, due to gzipping
            // messing with things).
            data.chunks.length.should.be.gte(3);

            // Make sure that there were 2 primary gaps between chunks from the
            // server (again, gzipping may introduce other chunks, but we're just
            // interested in ensuring the chunks sent back from the server are
            // present).
            var longTimeGaps = _.filter(data.chunkTimeGaps, function(gap) {
              return gap >= 400;
            });
            longTimeGaps.length.should.eql(2);

            done();
          });
        });
      });

      describe('when the underlying server supports gzip but the client does not', function() {
        it('combines small response chunks into a single response', function(done) {
          var options = {
            url: 'http://localhost:9080/compressible-delayed-chunked/10?api_key=' + this.apiKey,
            encoding: null,
          };

          shared.chunkedRequestDetails(options, function(response, data) {
            should.not.exist(response.headers['content-encoding']);
            response.headers['transfer-encoding'].should.eql('chunked');
            data.bodyString.length.should.eql(30);

            data.chunks.length.should.eql(1);

            done();
          });
        });

        it('still streams back the original chunks at different times if they are large enough', function(done) {
          var options = {
            url: 'http://localhost:9080/compressible-delayed-chunked/50000?api_key=' + this.apiKey,
            encoding: null,
          };

          shared.chunkedRequestDetails(options, function(response, data) {
            should.not.exist(response.headers['content-encoding']);
            response.headers['transfer-encoding'].should.eql('chunked');
            data.bodyString.length.should.eql(150000);

            var longTimeGaps = _.filter(data.chunkTimeGaps, function(gap) {
              return gap >= 400;
            });

            var shortTimeGaps = _.filter(data.chunkTimeGaps, function(gap) {
              return gap < 400;
            });

            // With response sizes this big, we'll have a lot of response
            // chunks, but what we mainly want to test is that there are
            // distinct gaps in the chunks corresponding to how the backend
            // streams stuff back.
            longTimeGaps.length.should.eql(2);
            shortTimeGaps.length.should.be.greaterThan(10);

            done();
          });
        });
      });
    });

    // Varnish 3 exhibited invalid responses when streaming was enabled and
    // dealing with gzipped, chunked responses:
    // https://www.varnish-cache.org/trac/ticket/1220
    //
    // This was fixed in Varnish 4, but test to try and ensure our stack
    // remains compatible with this scenario of streaming gzipped, chunked
    // responses.
    it('successfully responds when dealing with large-ish, gzipped, chunked responses', function(done) {
      this.timeout(120000);

      // Varnish 3 broken behavior only cropped up sporadically, but larger
      // responses seem to have triggered the behavior more frequently.
      // Responses somewhere in the neighborhood of 252850 bytes seemed to make
      // this problem reproducible. So test everything from 252850 - 253850
      // bytes.
      var sizes = _.times(1000, function(index) { return index + 252850; });
      var options = { gzip: true, agentOptions: { maxSockets: 150  } };
      async.eachLimit(sizes, 100, function(size, callback) {
        request.get('http://localhost:9080/compressible-chunked/1/' + size + '?api_key=' + this.apiKey, options, function(error, response, body) {
          response.statusCode.should.eql(200);
          response.headers['content-encoding'].should.eql('gzip');
          // FIXME: Investigate why Varnish 4 randomly doesn't actually send back
          // the responses as chunked.
          //
          //response.headers['transfer-encoding'].should.eql('chunked');
          //should.not.exist(response.headers['content-length']);
          body.toString().length.should.eql(size);
          callback();
        });
      }.bind(this), done);
    });
  });

  describe('cookies', function() {
    it('strips analytics cookies', function(done) {
      var options = {
        headers: {
          'Cookie': '__utma=foo; foo=bar; _ga=test; moo=boo',
        },
      };

      request.get('http://localhost:9080/info/?api_key=' + this.apiKey, options, function(error, response, body) {
        response.statusCode.should.eql(200);
        var data = JSON.parse(body);
        data.headers['cookie'].should.eql('foo=bar; moo=boo');
        done();
      });
    });
  });

  describe('timeouts', function() {
    var httpOptions = { agentOptions: { maxSockets: 150  } };

    it('times out quickly if a backend is down', function(done) {
      this.timeout(500);
      request.get('http://localhost:9080/down?api_key=' + this.apiKey, httpOptions, function(error, response) {
        response.statusCode.should.eql(502);
        done();
      });
    });

    it('behaves with 60-second connection timeouts', function(done) {
      this.timeout(85000);

      var apiKey = this.apiKey;

      // Parallelize all the 60-second timeout tests. Ideally these would be
      // represented as separate tests, but since mocha doesn't support
      // parallel tests, running these serially can quickly add up. So until
      // there's a better option, we'll run all these inside a single test in
      // parallel.
      async.parallel([
        // times out after 60 seconds if a backend is non-responsive for GET
        // requests
        function(callback) {
          var startTime = Date.now();
          request.get('http://localhost:9080/delay/65000?api_key=' + apiKey, httpOptions, function(error, response) {
            response.statusCode.should.eql(504);

            var duration = Date.now() - startTime;
            duration.should.be.greaterThan(60000);
            duration.should.be.lessThan(65000);
            callback();
          });
        },

        // times out after 60 seconds if a backend is non-responsive for
        // non-GET requests
        function(callback) {
          var startTime = Date.now();
          request.post('http://localhost:9080/delay/65000?api_key=' + apiKey, httpOptions, function(error, response) {
            response.statusCode.should.eql(504);

            var duration = Date.now() - startTime;
            duration.should.be.greaterThan(60000);
            duration.should.be.lessThan(65000);
            callback();
          });
        },

        // doesn't time out if a backend starts sending the request within 60
        // seconds
        function(callback) {
          request.get('http://localhost:9080/delays/57000/65000?api_key=' + apiKey, httpOptions, function(error, response, body) {
            response.statusCode.should.eql(200);
            body.should.eql('firstdone');
            callback();
          });
        },

        // doesn't time out if a backend sends chunks at least once every 60
        // seconds
        function(callback) {
          request.get('http://localhost:9080/delays/7000/65000?api_key=' + apiKey, httpOptions, function(error, response, body) {
            response.statusCode.should.eql(200);
            body.should.eql('firstdone');
            callback();
          });
        },

        // closes the response if the backend waits more than 60 seconds
        // between sending chunks
        function(callback) {
          request.get('http://localhost:9080/delays/3000/65000?api_key=' + apiKey, httpOptions, function(error, response, body) {
            response.statusCode.should.eql(200);
            body.should.eql('first');
            callback();
          });
        },

        // only sends 1 request to the backend on timeouts for GET requests
        //
        // This is to ensure that no proxy in front of the backend makes
        // multiple retry attempts when a request times out (since we don't
        // want to duplicate requests if a backend is already struggling).
        //
        // FIXME: Currently failing in Varnish. No apparent way to disable this
        // without completely disabling keep-alive (which I'm hesitant to do):
        //
        // https://www.varnish-cache.org/lists/pipermail/varnish-misc/2010-December/019538.html
        // https://www.varnish-cache.org/lists/pipermail/varnish-dev/2012-November/007378.html
        /*function(callback) {
          should.not.exist(global.backendCallCounts['get-timeout']);

          request.get('http://localhost:9080/timeout?api_key=' + apiKey, httpOptions, function(error, response) {
            response.statusCode.should.eql(504);

            // Ensure that the backend has only been called once.
            global.backendCallCounts['get-timeout'].should.eql(1);

            // Wait 10 seconds for any possible retry attempts that might be
            // pending, and then ensure the backend has still only been called
            // once.
            setTimeout(function() {
              global.backendCallCounts['get-timeout'].should.eql(1);
              callback();
            }, 10000);
          });
        },

        // only sends 1 request to the backend on timeouts for POST requests
        //
        // Same test as above, but ensure non-GET requests are behaving the
        // same (no retry allowed). This is probably even more important for
        // non-GET requests since duplicating POST requests could be harmful
        // (multiple creates, updates, etc).
        function(callback) {
          should.not.exist(global.backendCallCounts['post-timeout']);

          request.post('http://localhost:9080/timeout?api_key=' + apiKey, httpOptions, function(error, response) {
            response.statusCode.should.eql(504);

            // Ensure that the backend has only been called once.
            global.backendCallCounts['post-timeout'].should.eql(1);

            // Wait 10 seconds for any possible retry attempts that might be
            // pending, and then ensure the backend has still only been called
            // once.
            setTimeout(function() {
              global.backendCallCounts['post-timeout'].should.eql(1);
              callback();
            }, 10000);
          });
        },*/
      ], done);
    });
  });
});
