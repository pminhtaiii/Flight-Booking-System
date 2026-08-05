"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DisruptionAuditEventAction = exports.NotificationOutboxStatus = exports.NotificationOutboxType = exports.DuffelWebhookEventStatus = exports.MaterialDisruptionReason = exports.MaterialBaseline = exports.ItineraryRevisionSource = exports.DisruptionAttentionReason = exports.DisruptionActorType = exports.DisruptionResolvedReason = exports.DisruptionStatus = void 0;
var DisruptionStatus;
(function (DisruptionStatus) {
    DisruptionStatus["NONE"] = "NONE";
    DisruptionStatus["DETECTED"] = "DETECTED";
    DisruptionStatus["ACKNOWLEDGED"] = "ACKNOWLEDGED";
    DisruptionStatus["RESOLVED"] = "RESOLVED";
})(DisruptionStatus || (exports.DisruptionStatus = DisruptionStatus = {}));
var DisruptionResolvedReason;
(function (DisruptionResolvedReason) {
    DisruptionResolvedReason["TRAVELLER_ACCEPTED"] = "TRAVELLER_ACCEPTED";
    DisruptionResolvedReason["DEPARTURE_PASSED"] = "DEPARTURE_PASSED";
    DisruptionResolvedReason["ADMIN_RESOLVED"] = "ADMIN_RESOLVED";
    DisruptionResolvedReason["BOOKING_CANCELLED"] = "BOOKING_CANCELLED";
})(DisruptionResolvedReason || (exports.DisruptionResolvedReason = DisruptionResolvedReason = {}));
var DisruptionActorType;
(function (DisruptionActorType) {
    DisruptionActorType["TRAVELLER"] = "TRAVELLER";
    DisruptionActorType["SYSTEM"] = "SYSTEM";
    DisruptionActorType["ADMIN"] = "ADMIN";
})(DisruptionActorType || (exports.DisruptionActorType = DisruptionActorType = {}));
var DisruptionAttentionReason;
(function (DisruptionAttentionReason) {
    DisruptionAttentionReason["NOTIFICATION_THROTTLED"] = "NOTIFICATION_THROTTLED";
    DisruptionAttentionReason["AGED_UNRESOLVED"] = "AGED_UNRESOLVED";
    DisruptionAttentionReason["DATA_QUALITY"] = "DATA_QUALITY";
})(DisruptionAttentionReason || (exports.DisruptionAttentionReason = DisruptionAttentionReason = {}));
var ItineraryRevisionSource;
(function (ItineraryRevisionSource) {
    ItineraryRevisionSource["WEBHOOK"] = "WEBHOOK";
    ItineraryRevisionSource["RECONCILIATION"] = "RECONCILIATION";
    ItineraryRevisionSource["BOOTSTRAP"] = "BOOTSTRAP";
})(ItineraryRevisionSource || (exports.ItineraryRevisionSource = ItineraryRevisionSource = {}));
var MaterialBaseline;
(function (MaterialBaseline) {
    MaterialBaseline["INCREMENTAL"] = "INCREMENTAL";
    MaterialBaseline["CUMULATIVE"] = "CUMULATIVE";
})(MaterialBaseline || (exports.MaterialBaseline = MaterialBaseline = {}));
var MaterialDisruptionReason;
(function (MaterialDisruptionReason) {
    MaterialDisruptionReason["SEGMENT_REMOVED"] = "SEGMENT_REMOVED";
    MaterialDisruptionReason["SEGMENT_ADDED"] = "SEGMENT_ADDED";
    MaterialDisruptionReason["DEPARTURE_AIRPORT_CHANGED"] = "DEPARTURE_AIRPORT_CHANGED";
    MaterialDisruptionReason["ARRIVAL_AIRPORT_CHANGED"] = "ARRIVAL_AIRPORT_CHANGED";
    MaterialDisruptionReason["DEPARTURE_LOCAL_DATE_CHANGED"] = "DEPARTURE_LOCAL_DATE_CHANGED";
    MaterialDisruptionReason["ARRIVAL_LOCAL_DATE_CHANGED"] = "ARRIVAL_LOCAL_DATE_CHANGED";
    MaterialDisruptionReason["DEPARTURE_MOVED_EARLIER"] = "DEPARTURE_MOVED_EARLIER";
    MaterialDisruptionReason["DEPARTURE_MOVED_LATER"] = "DEPARTURE_MOVED_LATER";
    MaterialDisruptionReason["FINAL_ARRIVAL_MOVED_EARLIER"] = "FINAL_ARRIVAL_MOVED_EARLIER";
    MaterialDisruptionReason["FINAL_ARRIVAL_MOVED_LATER"] = "FINAL_ARRIVAL_MOVED_LATER";
    MaterialDisruptionReason["OVERNIGHT_CONNECTION_INTRODUCED"] = "OVERNIGHT_CONNECTION_INTRODUCED";
    MaterialDisruptionReason["CONNECTION_BELOW_MCT"] = "CONNECTION_BELOW_MCT";
    MaterialDisruptionReason["INVALID_CONNECTION_OVERLAP"] = "INVALID_CONNECTION_OVERLAP";
})(MaterialDisruptionReason || (exports.MaterialDisruptionReason = MaterialDisruptionReason = {}));
var DuffelWebhookEventStatus;
(function (DuffelWebhookEventStatus) {
    DuffelWebhookEventStatus["PENDING"] = "PENDING";
    DuffelWebhookEventStatus["PROCESSING"] = "PROCESSING";
    DuffelWebhookEventStatus["RETRY_SCHEDULED"] = "RETRY_SCHEDULED";
    DuffelWebhookEventStatus["PROCESSED"] = "PROCESSED";
    DuffelWebhookEventStatus["SKIPPED"] = "SKIPPED";
    DuffelWebhookEventStatus["FAILED_NEEDS_ATTENTION"] = "FAILED_NEEDS_ATTENTION";
})(DuffelWebhookEventStatus || (exports.DuffelWebhookEventStatus = DuffelWebhookEventStatus = {}));
var NotificationOutboxType;
(function (NotificationOutboxType) {
    NotificationOutboxType["MATERIAL_DISRUPTION"] = "MATERIAL_DISRUPTION";
})(NotificationOutboxType || (exports.NotificationOutboxType = NotificationOutboxType = {}));
var NotificationOutboxStatus;
(function (NotificationOutboxStatus) {
    NotificationOutboxStatus["PENDING"] = "PENDING";
    NotificationOutboxStatus["PROCESSING"] = "PROCESSING";
    NotificationOutboxStatus["DELIVERED"] = "DELIVERED";
    NotificationOutboxStatus["FAILED"] = "FAILED";
})(NotificationOutboxStatus || (exports.NotificationOutboxStatus = NotificationOutboxStatus = {}));
var DisruptionAuditEventAction;
(function (DisruptionAuditEventAction) {
    DisruptionAuditEventAction["DETECTED"] = "DETECTED";
    DisruptionAuditEventAction["ACKNOWLEDGED"] = "ACKNOWLEDGED";
    DisruptionAuditEventAction["TRAVELLER_ACCEPTED"] = "TRAVELLER_ACCEPTED";
    DisruptionAuditEventAction["DEPARTURE_RESOLVED"] = "DEPARTURE_RESOLVED";
    DisruptionAuditEventAction["BOOKING_CANCELLED"] = "BOOKING_CANCELLED";
    DisruptionAuditEventAction["ADMIN_RESOLVED"] = "ADMIN_RESOLVED";
    DisruptionAuditEventAction["EVENT_RETRIED"] = "EVENT_RETRIED";
    DisruptionAuditEventAction["ATTENTION_RAISED"] = "ATTENTION_RAISED";
    DisruptionAuditEventAction["ATTENTION_CLEARED"] = "ATTENTION_CLEARED";
})(DisruptionAuditEventAction || (exports.DisruptionAuditEventAction = DisruptionAuditEventAction = {}));
