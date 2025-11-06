// Load required packages
var mongoose = require('mongoose');

// Define our task schema
var TaskSchema = new mongoose.Schema({
    name: {
        type: String,
        required: [true, 'Task name is required']
    },
    description: {
        type: String,
        default: ''
    },
    deadline: {
        type: Date,
        required: [true, 'Task deadline is required']
    },
    completed: {
        type: Boolean,
        default: false
    },
    assignedUser: {
        type: String,
        default: ''
    },
    assignedUserName: {
        type: String,
        default: 'unassigned'
    },
    dateCreated: {
        type: Date,
        default: Date.now
    }
}, {
    versionKey: false
});

// Export the Mongoose model
module.exports = mongoose.model('Task', TaskSchema);
