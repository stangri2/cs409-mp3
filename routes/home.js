var mongoose = require('mongoose');
var User = require('../models/user');
var Task = require('../models/task');

module.exports = function (router) {
    var rootRoute = router.route('/');

    rootRoute.get(function (req, res) {
        res.json({ message: 'Llama.io task API is running', data: null });
    });

    function buildError(message, status, data) {
        var err = new Error(message);
        err.status = status || 500;
        err.data = data || null;
        return err;
    }

    function sendResponse(res, status, message, data) {
        res.status(status).json({ message: message, data: data });
    }

    function parseJSONParam(param, name) {
        if (param === undefined) {
            return undefined;
        }
        if (typeof param !== 'string') {
            return param;
        }
        try {
            return JSON.parse(param);
        } catch (err) {
            throw buildError('Invalid JSON in query parameter "' + name + '"', 400);
        }
    }

    function parseInteger(param, name) {
        if (param === undefined) {
            return undefined;
        }
        var parsed = parseInt(param, 10);
        if (isNaN(parsed) || parsed < 0) {
            throw buildError('Query parameter "' + name + '" must be a non-negative integer', 400);
        }
        return parsed;
    }

    function parseBoolean(param) {
        if (param === undefined) {
            return undefined;
        }
        if (typeof param === 'boolean') {
            return param;
        }
        var lowered = String(param).toLowerCase();
        if (lowered === 'true' || lowered === '1') {
            return true;
        }
        if (lowered === 'false' || lowered === '0') {
            return false;
        }
        return undefined;
    }

    function parseDateInput(value, fieldLabel) {
        if (value === undefined || value === null || value === '') {
            throw buildError(fieldLabel + ' is required.', 400);
        }

        var dateValue = value;
        if (typeof value === 'string') {
            var numericCandidate = Number(value);
            if (!Number.isNaN(numericCandidate)) {
                dateValue = numericCandidate;
            }
        }

        var parsed = new Date(dateValue);
        if (isNaN(parsed.getTime())) {
            throw buildError(fieldLabel + ' must be a valid date.', 400);
        }
        return parsed;
    }

    function normalizeIdArray(value) {
        if (!value && value !== 0) {
            return [];
        }
        if (Array.isArray(value)) {
            return value.map(String);
        }
        if (typeof value === 'string') {
            var trimmed = value.trim();
            if (!trimmed) {
                return [];
            }
            try {
                var parsed = JSON.parse(trimmed);
                if (Array.isArray(parsed)) {
                    return parsed.map(String);
                }
            } catch (err) {
                return trimmed.split(',').map(function (item) {
                    return item.trim();
                }).filter(Boolean);
            }
            return [trimmed];
        }
        return [];
    }

    function ensureValidObjectId(id, name) {
        if (!mongoose.Types.ObjectId.isValid(id)) {
            throw buildError('Invalid ' + name + ' id', 400);
        }
    }

    function mapMongooseError(err) {
        if (err && err.name === 'ValidationError') {
            return buildError(err.message, 400);
        }
        if (err && err.code === 11000) {
            return buildError('Email already exists. Please use a different email.', 400);
        }
        return buildError('An unexpected server error occurred.', 500, err);
    }

    async function applyPendingTasksToUser(user, pendingTaskIds) {
        pendingTaskIds = pendingTaskIds || [];
        if (!Array.isArray(pendingTaskIds)) {
            throw buildError('pendingTasks must be an array.', 400);
        }

        pendingTaskIds = Array.from(new Set(pendingTaskIds.map(function (id) {
            return id.toString();
        })));

        if (pendingTaskIds.length === 0) {
            // Remove all tasks previously assigned
            await Task.updateMany(
                { assignedUser: user._id.toString(), completed: false },
                { assignedUser: '', assignedUserName: 'unassigned' }
            );
            user.pendingTasks = [];
            return;
        }

        pendingTaskIds.forEach(function (taskId) {
            ensureValidObjectId(taskId, 'task');
        });

        var tasks = await Task.find({ _id: { $in: pendingTaskIds } });
        if (tasks.length !== pendingTaskIds.length) {
            throw buildError('One or more tasks were not found while updating pending tasks.', 404);
        }

        // Unassign tasks currently assigned to user but not in new list
        await Task.updateMany(
            {
                assignedUser: user._id.toString(),
                completed: false,
                _id: { $nin: pendingTaskIds }
            },
            { assignedUser: '', assignedUserName: 'unassigned' }
        );

        // Assign each task to user
        for (var i = 0; i < tasks.length; i += 1) {
            var task = tasks[i];
            var previousUserId = task.assignedUser;
            if (previousUserId && previousUserId !== user._id.toString()) {
                await User.updateOne(
                    { _id: previousUserId },
                    { $pull: { pendingTasks: task._id.toString() } }
                );
            }

            task.assignedUser = user._id.toString();
            task.assignedUserName = user.name;
            await task.save();
        }

        var pending = tasks.filter(function (task) {
            return task.completed !== true;
        }).map(function (task) {
            return task._id.toString();
        });
        user.pendingTasks = pending;
    }

    async function clearPendingTaskForUser(userId, taskId) {
        if (!userId) {
            return;
        }
        await User.updateOne(
            { _id: userId },
            { $pull: { pendingTasks: taskId } }
        );
    }

    async function handleListRequest(req, res, Model, options) {
        try {
            var where = parseJSONParam(req.query.where, 'where');
            var sort = parseJSONParam(req.query.sort, 'sort');
            var select = parseJSONParam(req.query.select || req.query.filter, 'select');
            var skip = parseInteger(req.query.skip, 'skip');
            var limit = parseInteger(req.query.limit, 'limit');
            var count = parseBoolean(req.query.count);

            if (count === undefined) {
                count = false;
            }

            if (limit === undefined && options && options.defaultLimit !== undefined) {
                limit = options.defaultLimit;
            }

            if (count) {
                var total = await Model.countDocuments(where || {});
                sendResponse(res, 200, 'OK', total);
                return;
            }

            var query = Model.find(where || {});
            if (select) {
                query = query.select(select);
            }
            if (sort) {
                query = query.sort(sort);
            }
            if (skip !== undefined) {
                query = query.skip(skip);
            }
            if (limit !== undefined && limit !== null) {
                query = query.limit(limit);
            }

            var documents = await query.exec();
            sendResponse(res, 200, 'OK', documents);
        } catch (error) {
            if (error && error.status) {
                sendResponse(res, error.status, error.message, error.data);
            } else {
                var mapped = mapMongooseError(error);
                sendResponse(res, mapped.status, mapped.message, mapped.data);
            }
        }
    }

    router.route('/users')
        .get(function (req, res) {
            return handleListRequest(req, res, User, { defaultLimit: undefined });
        })
        .post(async function (req, res) {
            try {
                var name = req.body.name;
                var email = req.body.email;
                var pendingTasksInput = normalizeIdArray(req.body.pendingTasks);

                if (!name) {
                    throw buildError('User name is required.', 400);
                }
                if (!email) {
                    throw buildError('User email is required.', 400);
                }

                var user = new User({
                    name: name,
                    email: email,
                    pendingTasks: []
                });

                var duplicate = await User.exists({ email: email });
                if (duplicate) {
                    throw buildError('Email already exists. Please use a different email.', 400);
                }

                if (pendingTasksInput.length > 0) {
                    await applyPendingTasksToUser(user, pendingTasksInput);
                }

                await user.save();

                sendResponse(res, 201, 'User created successfully.', user);
            } catch (error) {
                if (error && error.status) {
                    sendResponse(res, error.status, error.message, error.data);
                    return;
                }
                var mapped = mapMongooseError(error);
                sendResponse(res, mapped.status, mapped.message, mapped.data);
            }
        });

    router.route('/users/:id')
        .get(async function (req, res) {
            try {
                ensureValidObjectId(req.params.id, 'user');

                var select = parseJSONParam(req.query.select || req.query.filter, 'select');
                var query = User.findById(req.params.id);
                if (select) {
                    query = query.select(select);
                }
                var user = await query.exec();
                if (!user) {
                    throw buildError('User not found.', 404);
                }
                sendResponse(res, 200, 'OK', user);
            } catch (error) {
                if (error && error.status) {
                    sendResponse(res, error.status, error.message, error.data);
                    return;
                }
                var mapped = mapMongooseError(error);
                sendResponse(res, mapped.status, mapped.message, mapped.data);
            }
        })
        .put(async function (req, res) {
            try {
                ensureValidObjectId(req.params.id, 'user');

                var name = req.body.name;
                var email = req.body.email;
                var pendingTasksInput = normalizeIdArray(req.body.pendingTasks);

                if (!name) {
                    throw buildError('User name is required.', 400);
                }
                if (!email) {
                    throw buildError('User email is required.', 400);
                }

                var user = await User.findById(req.params.id);
                if (!user) {
                    throw buildError('User not found.', 404);
                }

                var duplicate = await User.exists({ email: email, _id: { $ne: user._id } });
                if (duplicate) {
                    throw buildError('Email already exists. Please use a different email.', 400);
                }

                user.name = name;
                user.email = email;

                await applyPendingTasksToUser(user, pendingTasksInput);
                await user.save();

                sendResponse(res, 200, 'User updated successfully.', user);
            } catch (error) {
                if (error && error.status) {
                    sendResponse(res, error.status, error.message, error.data);
                    return;
                }
                var mapped = mapMongooseError(error);
                sendResponse(res, mapped.status, mapped.message, mapped.data);
            }
        })
        .delete(async function (req, res) {
            try {
                ensureValidObjectId(req.params.id, 'user');
                var user = await User.findById(req.params.id);
                if (!user) {
                    throw buildError('User not found.', 404);
                }

                await Task.updateMany(
                    { assignedUser: user._id.toString() },
                    { assignedUser: '', assignedUserName: 'unassigned' }
                );

                await User.deleteOne({ _id: req.params.id });
                sendResponse(res, 200, 'User deleted successfully.', {});
            } catch (error) {
                if (error && error.status) {
                    sendResponse(res, error.status, error.message, error.data);
                    return;
                }
                var mapped = mapMongooseError(error);
                sendResponse(res, mapped.status, mapped.message, mapped.data);
            }
        });

    router.route('/tasks')
        .get(function (req, res) {
            return handleListRequest(req, res, Task, { defaultLimit: 100 });
        })
        .post(async function (req, res) {
            try {
                var name = req.body.name;
                if (!name) {
                    throw buildError('Task name is required.', 400);
                }

                var deadline = parseDateInput(req.body.deadline, 'Task deadline');

                var completedParsed = parseBoolean(req.body.completed);
                var completed = completedParsed !== undefined ? completedParsed : !!req.body.completed;

                var assignedUserId = req.body.assignedUser;
                var task = new Task({
                    name: name,
                    description: req.body.description || '',
                    deadline: deadline,
                    completed: completed,
                    assignedUser: '',
                    assignedUserName: 'unassigned'
                });

                if (assignedUserId) {
                    ensureValidObjectId(assignedUserId, 'user');
                    var assignedUser = await User.findById(assignedUserId);
                    if (!assignedUser) {
                        throw buildError('Assigned user not found.', 404);
                    }
                    task.assignedUser = assignedUserId;
                    task.assignedUserName = assignedUser.name;
                }

                await task.save();

                if (task.assignedUser) {
                    if (!task.completed) {
                        await User.updateOne(
                            { _id: task.assignedUser },
                            { $addToSet: { pendingTasks: task._id.toString() } }
                        );
                    }
                }

                sendResponse(res, 201, 'Task created successfully.', task);
            } catch (error) {
                if (error && error.status) {
                    sendResponse(res, error.status, error.message, error.data);
                    return;
                }
                var mapped = mapMongooseError(error);
                sendResponse(res, mapped.status, mapped.message, mapped.data);
            }
        });

    router.route('/tasks/:id')
        .get(async function (req, res) {
            try {
                ensureValidObjectId(req.params.id, 'task');
                var select = parseJSONParam(req.query.select || req.query.filter, 'select');
                var query = Task.findById(req.params.id);
                if (select) {
                    query = query.select(select);
                }
                var task = await query.exec();
                if (!task) {
                    throw buildError('Task not found.', 404);
                }
                sendResponse(res, 200, 'OK', task);
            } catch (error) {
                if (error && error.status) {
                    sendResponse(res, error.status, error.message, error.data);
                    return;
                }
                var mapped = mapMongooseError(error);
                sendResponse(res, mapped.status, mapped.message, mapped.data);
            }
        })
        .put(async function (req, res) {
            try {
                ensureValidObjectId(req.params.id, 'task');

                var name = req.body.name;
                if (!name) {
                    throw buildError('Task name is required.', 400);
                }

                var deadline = parseDateInput(req.body.deadline, 'Task deadline');

                var task = await Task.findById(req.params.id);
                if (!task) {
                    throw buildError('Task not found.', 404);
                }

                var previousAssignedUser = task.assignedUser;

                var completedParsed = parseBoolean(req.body.completed);
                var completed = completedParsed !== undefined ? completedParsed : !!req.body.completed;

                var assignedUserId = req.body.assignedUser;
                var assignedUserName = 'unassigned';

                if (assignedUserId) {
                    ensureValidObjectId(assignedUserId, 'user');
                    var assignedUser = await User.findById(assignedUserId);
                    if (!assignedUser) {
                        throw buildError('Assigned user not found.', 404);
                    }
                    assignedUserName = assignedUser.name;
                } else {
                    assignedUserId = '';
                }

                task.name = name;
                task.description = req.body.description || '';
                task.deadline = deadline;
                task.completed = completed;
                task.assignedUser = assignedUserId;
                task.assignedUserName = assignedUserName;

                await task.save();

                if (previousAssignedUser && previousAssignedUser !== assignedUserId) {
                    await clearPendingTaskForUser(previousAssignedUser, task._id.toString());
                }

                if (!assignedUserId) {
                    await clearPendingTaskForUser(previousAssignedUser, task._id.toString());
                } else {
                    if (task.completed) {
                        await clearPendingTaskForUser(assignedUserId, task._id.toString());
                    } else {
                        await User.updateOne(
                            { _id: assignedUserId },
                            { $addToSet: { pendingTasks: task._id.toString() } }
                        );
                    }
                }

                sendResponse(res, 200, 'Task updated successfully.', task);
            } catch (error) {
                if (error && error.status) {
                    sendResponse(res, error.status, error.message, error.data);
                    return;
                }
                var mapped = mapMongooseError(error);
                sendResponse(res, mapped.status, mapped.message, mapped.data);
            }
        })
        .delete(async function (req, res) {
            try {
                ensureValidObjectId(req.params.id, 'task');
                var task = await Task.findById(req.params.id);
                if (!task) {
                    throw buildError('Task not found.', 404);
                }
                await Task.deleteOne({ _id: req.params.id });
                if (task.assignedUser) {
                    await clearPendingTaskForUser(task.assignedUser, task._id.toString());
                }
                sendResponse(res, 200, 'Task deleted successfully.', {});
            } catch (error) {
                if (error && error.status) {
                    sendResponse(res, error.status, error.message, error.data);
                    return;
                }
                var mapped = mapMongooseError(error);
                sendResponse(res, mapped.status, mapped.message, mapped.data);
            }
        });

    return router;
};
