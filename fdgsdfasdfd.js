'use strict';
const { helper } = require("t5-database");
const { startExecution, createUniqueName, getExecutionHistory } = require("../src/aws.helper");

const triggerContactAutomation = async (orgId, contact, operationType) => {
    try {
        console.log("Triggered contact field ", operationType)
        await helper.init(10, process.env.DATABASE, "automation");
        await helper.selectCollection("automation");
        let agg = [
            {
                '$match': {
                    'organizationId': await helper.makeId(orgId),
                    arn: { $ne: "" }
                }
            }, {
                '$unwind': {
                    'path': '$blueprint'
                }
            }, {
                '$match': {
                    ["blueprint.data.event." + operationType]: true
                }
            }, {
                '$group': {
                    '_id': {
                        '_id': '$_id'
                    },
                    'name': {
                        '$first': '$name'
                    },
                    'arn': {
                        '$first': '$arn'
                    },
                    'deletedAt': {
                        '$first': '$deletedAt'
                    }
                }
            }
        ];
        console.log("debug log 2");
        console.log("automation trigger agg", JSON.stringify(agg))
        console.time("Start db agg");
        let automations = await helper.aggregate(agg);
        console.log("debug log 3");
        console.timeEnd("Start db agg");
        console.log("agg >>>> ", JSON.stringify(agg), automations )
        if (automations.length) {
            for (let a = 0; a < automations.length; a++) {
                if (automations[a].arn) {
                    console.time("Trigger exce step func " + automations[a].arn)
                    console.log("Autmation triggering > ", automations[a].name)
                    contact.orgId = orgId;
                    contact.automationId = automations[a]._id._id;
                    let execName = await createUniqueName('AUTOMATION_EXECUTION');
                    contact.execArn = automations[a].arn.replace("stateMachine", "execution") + ":" + execName;
                    let execution = await startExecution(automations[a].arn, JSON.stringify(contact), process.env.REGION, execName);
                    console.log("execution -->", execution);
                    console.timeEnd("Trigger exce step func " + automations[a].arn)
                } else {
                    console.log("Automation does not have arn", automations[a].name)
                }
            }
        } else {
            console.log("Automation not found")
        }
    } catch(e) {
        console.log('Error in contact field automation trigger', e);
    }
    return true;
}
module.exports = {
    triggerContactAutomation
}
