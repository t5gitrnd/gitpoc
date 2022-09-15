'use strict';

const { helper } = require("t5-database");
const { Response, Exception, automationhelper } = require("../../../../libs");
const moment = require("moment");

const handlerList = async (event, context) => {
    context.callbackWaitsForEmptyEventLoop = false;
    let response = {};

    try {
        let aggregation = [];
        let auth = event.requestContext.authorizer;
        let contactId = event.pathParameters.id;
        let page = event.queryStringParameters ? (event.queryStringParameters.pageId ? event.queryStringParameters.pageId : 1) : 1;
        let limit = Number(process.env.LIMIT);
        let skip = (page - 1) * limit;
        aggregation.push({ $match: { contactId: await helper.makeId(contactId) } });
        aggregation.push({ $match: { orgId: await helper.makeId(auth.organizationId) } });
        aggregation.push({
            $lookup: {
                from: 'users',
                localField: 'createdBy',
                foreignField: '_id',
                as: 'createdBy'
            }
        });
        aggregation.push({
            $unwind: {
                path: '$createdBy'
            }
        });

        /**
         * Add full name fields
         */
        aggregation.push({
            $addFields: {
                "name": { "$concat": [{$ifNull:["$firstName",""]}, " ", {$ifNull:["$lastName",""]}] },
                "createdBy": { "$concat": ["$createdBy.firstName", " ", "$createdBy.lastName"] }
            }
        });
        aggregation.push({
            $lookup: {
                from: 'tags',
                localField: 'tags',
                foreignField: '_id',
                as: 'tagNames'
            }
        });
        aggregation.push({
            $addFields: {
                rescheduleCount: {$size: "$history"}
            }
        })
        aggregation.push({
            $unwind: {
                path: '$history',
                preserveNullAndEmptyArrays: true
            }
        });
        aggregation.push({
            $lookup: {
                from: 'users',
                localField: 'history.rescheduledBy',
                foreignField: '_id',
                as: 'history.rescheduledByName'
            }
        })
        aggregation.push({
            $unwind: {
                path: "$history.rescheduledByName",
                preserveNullAndEmptyArrays: true
            }
        });
        aggregation.push({
            $addFields: {
                "history.rescheduledByName": { "$concat": [{$ifNull:["$history.rescheduledByName.firstName",""]}, " ", {$ifNull:["$history.rescheduledByName.lastName",""]}] }
            }
        })
        aggregation.push({
            $unwind: {
                path: "$history.rescheduledByName",
                preserveNullAndEmptyArrays: true
            }
        })
        aggregation.push({
            $group: {
                _id: "$_id",
                agenda: { $first: "$agenda" },
                contactId: { $first: "$contactId" },
                history: {"$push": "$history"},
                orgId: { $first: "$orgId" },
                tags: {$first: "$tags"},
                date: {$first: "$date"},
                toTime: {$first: "$toTime"},
                fromTime: {$first: "$fromTime"},
                status: {$first: "$status"},
                createdBy: {$first: "$createdBy"},
                tagNames: {$first: "$tagNames"},
                createdAt: {$first: "$createdAt"},
                rescheduleCount: { $first: "$rescheduleCount"},
                note: { $first: "$note"}
            }
        });
        aggregation.push({
            $addFields: {
                "history": {
                    "$cond": [
                        {$gt: ["$rescheduleCount", 0]},
                        "$history",
                        "$$REMOVE"

                    ]
                }
            }
        })
        aggregation.push({ $sort: { createdAt: -1 } });
        aggregation.push({
            $facet: {
                paginatedResults: [{$skip: skip}, {$limit: limit}],
                totalCount: [
                    {
                        $count: 'count'
                    }
                ]
            }
        });
        let appointments = await helper.aggregate(aggregation);
        let paginatedAppointments = appointments[0] ? appointments[0].paginatedResults : [];
        let totalRecords = appointments[0] && appointments[0].totalCount && appointments[0].totalCount[0] ? appointments[0].totalCount[0].count : 0
        response = await Response.success({
            "appointments": paginatedAppointments,
            "pagination": {
                "count": totalRecords,
                "currentPage": Number(page),
                "totalPages": Math.ceil(totalRecords / limit),
            }
        });
    }
    catch (e) {
        console.log('Error in appointments listing', e);
        response = await Response.failure(e.message, e.status);
    }
    return response;
}

const handlerCreate = async (event, context) => {
    context.callbackWaitsForEmptyEventLoop = false;
    let response = {};
    try {
        let auth = event.requestContext.authorizer;
        const parsedBody = event.body;
        if (!moment(parsedBody.date, 'MM/DD/YYYY').isValid() || !moment(parsedBody.toTime, 'hh:mm A').isValid() || !moment(parsedBody.fromTime, 'hh:mm A').isValid()) {
            throw new Exception.BadRequest('Please provide a valid date and time.');
        }
        if ((moment().isAfter(moment(parsedBody.date, 'MM/DD/YYYY')))) {
            throw new Exception.BadRequest('Please provide a future date.');
        }
        if (moment(parsedBody.toTime, 'hh:mm A').isBefore(moment(parsedBody.fromTime, 'hh:mm A'))) {
            throw new Exception.BadRequest('To time should be greater than from time.');
        }
        if (parsedBody.toTime == parsedBody.fromTime) {
            throw new Exception.BadRequest('To time and from time should not be same.');
        }
        const query = {};
        const datePipeArray = [];
        let queryStartDate = moment(parsedBody.date + " " + parsedBody.fromTime, "L LT").format("YYYY-MM-DD HH:mm:ss")
        let queryEndDate = moment(parsedBody.date + " " + parsedBody.toTime, "L LT").format("YYYY-MM-DD HH:mm:ss")
        datePipeArray.push({ "$and":[
                { "fromDateTime": { $gte: queryStartDate } },
                { "toDateTime": { $lte: queryEndDate } }
            ]});
        datePipeArray.push({ "$and":[
                { "toDateTime": { $gte: queryStartDate } },
                { "toDateTime": { $lte: queryEndDate } }
            ]});
        datePipeArray.push({ "$and":[
                { "fromDateTime": { $gte: queryStartDate } },
                { "fromDateTime": { $lte: queryEndDate } }
            ]});
        datePipeArray.push({ "$and":[
                { "fromDateTime": { $lte: queryStartDate } },
                { "toDateTime": { $gte: queryEndDate } }
            ]});
        query["$or"] = datePipeArray;
        const matchAggr = [
            {
                $match: {
                    contactId: await helper.makeId(parsedBody.contactId)
                }
            }, {
                $match: { status: { $in: ["scheduled", "rescheduled"]} }
            }, {
                $match: {
                    date: parsedBody.date
                }
            }, {
                $match: query
            }
        ]
        let checkAvailablity = await helper.aggregate(matchAggr);
        if (checkAvailablity.length > 0) {
            throw new Exception.BadRequest('Appointment is overlapping with another appointment.');
        }
        let now = (new Date()).toISOString().slice(0, 19).replace("T", " ");
        let userId = await helper.makeId(auth._id);
        let tags = [];
        if (parsedBody.tags.length > 0) {
            for (let i = 0; i < parsedBody.tags.length; i++) {
                let objTagId = await helper.makeId(parsedBody.tags[i]);
                tags.push(objTagId);
            }
        }
        let appointment = {
            'agenda': parsedBody.agenda,
            "contactId": await helper.makeId(parsedBody.contactId),
            "date": parsedBody.date,
            "toTime": parsedBody.toTime,
            "toDateTime": moment(parsedBody.date + " " + parsedBody.toTime, "L LT").format("YYYY-MM-DD HH:mm:ss"),
            "fromTime": parsedBody.fromTime,
            "fromDateTime": moment(parsedBody.date + " " + parsedBody.fromTime, "L LT").format("YYYY-MM-DD HH:mm:ss"),
            "tags": tags,
            "history": [],
            "status": "scheduled",
            "orgId": await helper.makeId(auth.organizationId),
            "createdBy": userId,
            "updatedBy": userId,
            "createdAt": now,
            "updatedAt": now
        };

        let newAppointment = await helper.insertOne(appointment);
        await callAutomation(newAppointment.insertedId, "appointmentCreate")
        response = await Response.success(newAppointment.ops[0]);
    }
    catch (e) {
        console.log('Error while creating appointment', e);
        response = await Response.failure(e.message, e.status);
    }
    return response;
};
const handlerDelete = async (event, context) => {
    context.callbackWaitsForEmptyEventLoop = false;
    let response;
    try {
        let data = await helper.findById(event.pathParameters.id);
        if (!data) {
            throw new Exception.BadRequest('Appointment not found.');
        }
        await helper.aggregate([ { $match: {_id: {$in: [await helper.makeId(event.pathParameters.id)]}} },
            { $merge: ("appointment_deleted").toLowerCase() } ]);
        await helper.deleteForce({_id: {$in: [await helper.makeId(event.pathParameters.id)]}}, false);
        await callAutomation(data._id, "appointmentDeleted")
        response = await Response.success("Appointment deleted successfully.");
    } catch (e) {
        console.log('Error while updating appointment', e);
        response = await Response.failure(e.message, e.status);
    }
    return response;
};
const callAutomation = async (id, status) => {
    await helper.selectCollection("appointments");
    let data = await helper.findById(id);
    await helper.selectCollection("organizations");
    let org = await helper.findById(data.orgId);
    const contactsCollection = ("contacts_" + org.code).toLowerCase();
    await helper.selectCollection(contactsCollection);
    let contact = await helper.findById(data.contactId);
    let tagsArr = [];
    if (contact.tags && contact.tags.length) {
        for (let t = 0; t < contact.tags.length; t++) {
            tagsArr.push(contact.tags[t]._id);
        }
    }
    contact.tags = tagsArr.toString();
    // Trigger Automation
    let appointmentAutomation = {
        'appointment_agenda': data.agenda,
        "appointment_contactId": await helper.makeId(data.contactId),
        "appointment_date": data.date,
        "appointment_toTime": data.toTime,
        "appointment_toDateTime": data.toDateTime,
        "appointment_fromTime": data.fromTime,
        "appointment_fromDateTime": data.fromDateTime,
        "appointment_tags": data.tags,
        "appointment_status": data.status,
        "appointment_orgId": await helper.makeId(data.orgId),
        "appointment_createdBy": data.createdBy,
        "appointment_updatedBy": data.updatedBy,
        "appointment_createdAt": data.createdAt,
        "appointment_updatedAt": data.updatedAt
    };
    appointmentAutomation.appointment_tags = appointmentAutomation.appointment_tags.toString();
    let payload = contact. (appointmentAutomation);
    console.log("Appointment create automation trigger", payload);
    await automationhelper.triggerContactAutomation(data.orgId, payload, status);
    return true;
}
module.exports = {
    handlerList,
    handlerCreate,
    handlerDelete
}
