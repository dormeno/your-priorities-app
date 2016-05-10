var express = require('express');
var router = express.Router();
var models = require("../models");
var auth = require('../authorization');
var log = require('../utils/logger');
var toJson = require('../utils/to_json');
var async = require('async');

var changePostCounter = function (req, postId, column, upDown, next) {
  models.Post.find({
    where: { id: postId }
  }).then(function(post) {
    if (post && upDown === 1) {
      post.increment(column);
    } else if (post && upDown === -1) {
      post.decrement(column);
    }
    models.Group.addUserToGroupIfNeeded(post.group_id, req, function () {
      next();
    });
  });
};

var decrementOldCountersIfNeeded = function (req, oldEndorsementValue, postId, endorsement, next) {
  if (oldEndorsementValue) {
    if (oldEndorsementValue>0) {
      changePostCounter(req, postId, 'counter_endorsements_up', -1, function () {
        next();
      })
    } else if (oldEndorsementValue<0) {
      changePostCounter(req, postId, 'counter_endorsements_down', -1, function () {
        next();
      })
    } else {
      log.error("Strange state of endorsements");
      next();
    }
  } else {
    next();
  }
};

var sendPostOrError = function (res, post, context, user, error, errorStatus) {
  if (error || !post) {
    if (errorStatus == 404) {
      log.warn("Post Not Found", { context: context, post: toJson(post), user: toJson(user), err: error,
        errorStatus: 404 });
    } else {
      log.error("Post Error", { context: context, post: toJson(post), user: toJson(user), err: error,
        errorStatus: errorStatus ? errorStatus : 500 });
    }
    if (errorStatus) {
      res.sendStatus(errorStatus);
    } else {
      res.sendStatus(500);
    }
  } else {
    res.send(post);
  }
};

router.delete('/:postId/:activityId/delete_activity', auth.can('edit post'), function(req, res) {
  models.AcActivity.find({
    where: {
      post_id: req.params.postId,
      id: req.params.activityId
    }
  }).then(function (activity) {
    activity.deleted = true;
    activity.save().then(function () {
      res.send( { activityId: activity.id });
    })
  }).catch(function (error) {
    log.error('Could not delete activity for post', {
      err: error,
      context: 'delete_activity',
      user: toJson(req.user.simple())
    });
    res.sendStatus(500);
  });
});

router.post('/:id/status_change', auth.can('send status change'), function(req, res) {
  models.Post.find({
    where: {
      id: req.params.id
    },
    include: [
      {
        model: models.Group,
        required: true,
        attributes: ['id'],
        include: [
          {
            model: models.Community,
            required: true,
            attributes: ['id'],
            include: [
              {
                model: models.Domain,
                required: true,
                attributes: ['id']
              }
            ]
          }
        ]
      }
    ]
  }).then(function (post) {
    if (post) {
      models.PostStatusChange.build({
        post_id: post.id,
        status_changed_to: post.official_status != parseInt(req.body.official_status) ? req.body.official_status : null,
        content: req.body.content,
        user_id: req.user.id,
        status: 'active',
        user_agent: req.useragent.source,
        ip_address: req.clientIp
      }).save().then(function (post_status_change) {
        if (post_status_change) {
          models.AcActivity.createActivity({
            type: 'activity.post.status.change',
            userId: req.user.id,
            postId: post.id,
            postStatusChangeId: post_status_change.id,
            groupId: post.Group.id,
            communityId: post.Group.Community.id,
            domainId: post.Group.Community.Domain.id
          }, function (error) {
            if (error) {
              log.error("Post Status Change Error", { context: 'status_change', post: toJson(post), user: toJson(req.user), err: error });
              res.sendStatus(500);
            } else {
              if (post.official_status != parseInt(req.body.official_status)) {
                post.official_status = req.body.official_status;
                post.save().then(function (results) {
                  log.info('Post Status Change Created And New Status', { post: toJson(post), context: 'status_change', user: toJson(req.user) });
                  res.sendStatus(200);
                });
              } else {
                log.info('Post Status Change Created', { post: toJson(post), context: 'status_change', user: toJson(req.user) });
                res.sendStatus(200);
              }
            }
          });
        } else {
          log.error("Post Status Change Error", { context: 'status_change', post: toJson(post), user: toJson(req.user), err: "Could not created status change" });
          res.sendStatus(500);
        }
      }).catch(function (error) {
        log.error("Post Status Change Error", { context: 'status_change', post: toJson(post), user: toJson(req.user), err: error });
        res.sendStatus(500);
      });
    } else {
      log.error("Post Status Change Post Not Found", { context: 'status_change', postId: req.params.id, user: toJson(req.user), err: "Could not created status change" });
      res.sendStatus(404);
    }
  });
});

router.get('/:id', auth.can('view post'), function(req, res) {
  models.Post.find({
    where: {
      id: req.params.id
    },
    include: [
      {
        // Category
        model: models.Category,
        required: false,
        include: [
          {
            model: models.Image,
            required: false,
            as: 'CategoryIconImages'
          }
        ]
      },
      // Group
      {
        model: models.Group,
        include: [
          {
            model: models.Category,
            required: false
          },
          {
            model: models.Community,
            attributes: ['id','name','theme_id'],
            required: false
          }
        ]
      },
      // User
      {
        model: models.User,
        required: false,
        attributes: models.User.defaultAttributesWithSocialMediaPublic
      },
      // Image
      {
        model: models.Image,
        required: false,
        as: 'PostHeaderImages'
      },
      // PointRevision
      {
        model: models.PostRevision,
        required: false
      }
    ]
  }).then(function(post) {
    if (post) {
      log.info('Post Viewed', { post: toJson(post), context: 'view', user: toJson(req.user) });
      res.send(post);
    } else {
      sendPostOrError(res, req.params.id, 'view', req.user, 'Not found', 404);
    }
  }).catch(function(error) {
    sendPostOrError(res, null, 'view', req.user, error);
  });
});

router.get('/:id/points', auth.can('view post'), function(req, res) {
  models.Point.findAll({
    where: {
      post_id: req.params.id
    },
    order: [
      models.sequelize.literal('(counter_quality_up-counter_quality_down) desc'),
      [ models.PointRevision, models.User, { model: models.Organization, as: 'OrganizationUsers' }, { model: models.Image, as: 'OrganizationLogoImages' }, 'created_at', 'asc' ]
    ],
    include: [
      {
        model: models.PointRevision,
        required: false,
        include: [
          { model: models.User,
            attributes: ["id", "name", "email", "facebook_id", "twitter_id", "google_id", "github_id"],
            required: false,
            include: [
              {
                model: models.Image, as: 'UserProfileImages',
                required: false
              },
              {
                model: models.Organization,
                as: 'OrganizationUsers',
                required: false,
                attributes: ['id', 'name'],
                include: [
                  {
                    model: models.Image,
                    as: 'OrganizationLogoImages',
                    attributes: ['id', 'formats'],
                    required: false
                  }
                ]
              }
            ]
          }
        ]
      },
      { model: models.PointQuality,
        required: false,
        include: [
          { model: models.User,
            attributes: ["id", "name", "email"],
            required: false
          }
        ]
      },
      {
        model: models.Post,
        required: false
      }
    ]
  }).then(function(points) {
    if (points) {
      log.info('Points Viewed', { postId: req.params.id, context: 'view', user: toJson(req.user) });
      res.send(points);
    } else {
      sendPostOrError(res, null, 'view', req.user, 'Not found', 404);
    }
  }).catch(function(error) {
    sendPostOrError(res, null, 'view', req.user, error);
  });
});

router.post('/:groupId', auth.can('create post'), function(req, res) {
  var post = models.Post.build({
    name: req.body.name,
    description: req.body.description,
    group_id: req.params.groupId,
    category_id: req.body.categoryId != "" ? req.body.categoryId : null,
    location: req.body.location != "" ? JSON.parse(req.body.location) : null,
    cover_media_type: req.body.coverMediaType,
    user_id: req.user.id,
    status: 'published',
    content_type: models.Post.CONTENT_IDEA,
    user_agent: req.useragent.source,
    ip_address: req.clientIp
  });
  post.save().then(function() {
    log.info('Post Created', { post: toJson(post), context: 'create', user: toJson(req.user) });
    post.setupAfterSave(req, res, function () {
      post.updateAllExternalCounters(req, 'up', 'counter_posts', function () {
        models.Group.addUserToGroupIfNeeded(post.group_id, req, function () {
          post.setupImages(req.body, function (error) {
            models.AcActivity.createActivity({
              type: 'activity.post.new',
              userId: post.user_id,
              domainId: req.ypDomain.id,
              groupId: post.group_id,
              communityId: req.ypCommunity ?  req.ypCommunity.id : null,
              postId : post.id,
              access: models.AcActivity.ACCESS_PUBLIC
            }, function (error) {
              sendPostOrError(res, post, 'setupImages', req.user, error);
            });
          })
        })
      })
    });
  }).catch(function(error) {
    sendPostOrError(res, null, 'view', req.user, error);
  });
});

router.put('/:id', auth.can('edit post'), function(req, res) {
  models.Post.find({
    where: {id: req.params.id }
  }).then(function (post) {
    if (post) {
      post.name = req.body.name;
      post.description = req.body.description;
      post.category_id = req.body.categoryId != "" ? req.body.categoryId : null;
      post.location = req.body.location != "" ? JSON.parse(req.body.location) : null;
      post.cover_media_type = req.body.coverMediaType;
      post.save().then(function () {
        log.info('Post Update', { post: toJson(post), context: 'create', user: toJson(req.user) });
        post.setupImages(req.body, function (error) {
          sendPostOrError(res, post, 'setupImages', req.user, error);
        })
      });
    } else {
      sendPostOrError(res, req.params.id, 'update', req.user, 'Not found', 404);
    }
  }).catch(function(error) {
    sendPostOrError(res, null, 'update', req.user, error);
  });
});

router.delete('/:id', auth.can('edit post'), function(req, res) {
  models.Post.find({
    where: {id: req.params.id }
  }).then(function (post) {
    post.deleted = true;
    post.save().then(function () {
      log.info('Post Deleted', { post: toJson(post), context: 'delete', user: toJson(req.user) });
      post.updateAllExternalCounters(req, 'down', 'counter_posts', function () {
        models.AcActivity.findAll({
          attributes: ['id','deleted'],
          include: [
            {
              model: models.Post,
              required: true,
              where: {
                id: post.id
              }
            }
          ]
        }).then(function (activities) {
          async.eachSeries(activities, function (activity, innerCallback) {
            activity.deleted = true;
            activity.save().then(function () {
              innerCallback();
            });
          }, function done() {
            res.sendStatus(200);
          });
        });
      });
    });
  }).catch(function(error) {
    sendPostOrError(res, null, 'delete', req.user, error);
  });
});

router.get('/:id/endorsements', auth.can('view post'), function(req, res) {
  models.Endorsement.findAll({
    where: {post_id: req.params.id, status: 'active'},
    order: "created_at DESC",
    include: [
      { model: models.User,
        attributes: ["id", "name", "facebook_id", "buddy_icon_file_name"]
      }
    ]
  }).then(function(endorsements) {
    if (endorsements) {
      log.info('Endorsements Viewed', { endorsements: toJson(endorsements), context: 'view', user: toJson(req.user) });
      res.send(endorsements);
    } else {
      log.warn("Endorsements Not found", { context: 'view', post: toJson(post), user: toJson(req.user),
        err: error, errorStatus: 404 });
    }
  }).catch(function(error) {
    log.error("Endorsements Error", { context: 'view', endorsements: req.params.id, user: toJson(req.user),
      err: error, errorStatus: 500 });
  });
});

router.post('/:id/endorse', auth.isLoggedIn, auth.can('vote on post'), function(req, res) {
  var post;

  models.Endorsement.find({
    where: {
      post_id: req.params.id,
      user_id: req.user.id
    },
    include: [
      {
        model: models.Post,
        attributes: ['id','group_id']
      }
    ]
  }).then(function(endorsement) {
    var oldEndorsementValue;
    if (endorsement) {
      post = endorsement.Post;
      if (endorsement.value>0)
        oldEndorsementValue = 1;
      else if (endorsement.value<0)
        oldEndorsementValue = -1;
      endorsement.value = req.body.value;
      endorsement.status = 'active';
    } else {
      endorsement = models.Endorsement.build({
        post_id: req.params.id,
        value: req.body.value,
        user_id: req.user.id,
        status: 'active',
        user_agent: req.useragent.source,
        ip_address: req.clientIp
      })
    }
    endorsement.save().then(function() {
      log.info('Endorsements Created', { endorsement: toJson(endorsement), context: 'create', user: toJson(req.user) });
      async.series([
        function (seriesCallback) {
          if (post) {
            seriesCallback();
          } else {
            models.Post.find( {
              where: { id: endorsement.post_id },
              attributes: ['id','group_id']
            }).then(function (results) {
              if (results) {
                post = results;
                seriesCallback();
              } else {
                seriesCallback("Can't find post")
              }
            });
          }
        },
        function (seriesCallback) {
          models.AcActivity.createActivity({
            type: endorsement.value>0 ? 'activity.post.endorsement.new' : 'activity.post.opposition.new',
            userId: endorsement.user_id,
            domainId: req.ypDomain.id,
            communityId: req.ypCommunity ?  req.ypCommunity.id : null,
            groupId : post.group_id,
            postId : post.id,
            access: models.AcActivity.ACCESS_PUBLIC
          }, function (error) {
            seriesCallback(error);
          });
        }
      ], function (error) {
        if (error) {
          log.error("Endorsements Error", { context: 'create', endorsement: toJson(endorsement), user: toJson(req.user),
            err: error, errorStatus: 500 });
          res.sendStatus(500);
        } else {
          decrementOldCountersIfNeeded(req, oldEndorsementValue, req.params.id, endorsement, function () {
            if (endorsement.value>0) {
              changePostCounter(req, req.params.id, 'counter_endorsements_up', 1, function () {
                res.send({ endorsement: endorsement, oldEndorsementValue: oldEndorsementValue });
              })
            } else if (endorsement.value<0) {
              changePostCounter(req, req.params.id, 'counter_endorsements_down', 1, function () {
                res.send({ endorsement: endorsement, oldEndorsementValue: oldEndorsementValue });
              })
            } else {
              log.error("Endorsements Error State", { context: 'create', endorsement: toJson(endorsement), user: toJson(req.user),
                err: error, errorStatus: 500 });
              res.sendStatus(500);
            }
          });
        }
      });

    });
  }).catch(function(error) {
    log.error("Endorsements Error", { context: 'create', post: req.params.id, user: toJson(req.user),
      err: error, errorStatus: 500 });
    res.sendStatus(500);
  });
});

router.delete('/:id/endorse', auth.isLoggedIn, auth.can('vote on post'), function(req, res) {
  console.log("user: "+req.user.id + " post: " + req.params.id);
  models.Endorsement.find({
    where: { post_id: req.params.id, user_id: req.user.id }
  }).then(function(endorsement) {
    if (endorsement) {
      var oldEndorsementValue;
      if (endorsement.value>0)
        oldEndorsementValue = 1;
      else if (endorsement.value<0)
        oldEndorsementValue = -1;
      endorsement.value = 0;
      //endorsement.deleted = true;
      endorsement.save().then(function() {
        if (oldEndorsementValue>0) {
          changePostCounter(req, req.params.id, 'counter_endorsements_up', -1, function () {
            res.status(200).send({ endorsement: endorsement, oldEndorsementValue: oldEndorsementValue });
          })
        } else if (oldEndorsementValue<0) {
          changePostCounter(req, req.params.id, 'counter_endorsements_down', -1, function () {
            res.status(200).send({ endorsement: endorsement, oldEndorsementValue: oldEndorsementValue });
          })
        } else {
          log.error("Endorsement Strange state", { context: 'delete', post: req.params.id, user: toJson(req.user),
            err: "Strange state of endorsements", errorStatus: 500 });
          res.sendStatus(500);
        }
      });
    } else {
      log.error("Endorsement Not found", { context: 'delete', post: req.params.id, user: toJson(req.user),
        err: error, errorStatus: 404 });
      res.sendStatus(404);
    }
  }).catch(function(error) {
    log.error("Endorsements Error", { context: 'delete', post: req.params.id, user: toJson(req.user),
      err: error, errorStatus: 500 });
    res.sendStatus(500);
  });
});

module.exports = router;
