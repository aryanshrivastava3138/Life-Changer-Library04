import { useState, useEffect } from 'react';
import { View, Text, StyleSheet, ScrollView, RefreshControl, Alert, TouchableOpacity } from 'react-native';
import { router } from 'expo-router';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/lib/supabase';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { CashPayment, User, SeatBooking, Admission } from '@/types/database';
import { formatDate } from '@/utils/dateUtils';
import { ArrowLeft, CircleCheck as CheckCircle, Circle as XCircle, Clock, Banknote, MapPin, Calendar, GraduationCap } from 'lucide-react-native';

interface CashPaymentWithDetails extends CashPayment {
  user: User;
  booking?: SeatBooking;
  admission?: Admission;
}

export default function AdminPaymentsScreen() {
  const { user } = useAuth();
  const [cashPayments, setCashPayments] = useState<CashPaymentWithDetails[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [processing, setProcessing] = useState<string | null>(null);

  // Redirect if not admin
  if (user?.role !== 'admin') {
    router.replace('/admin');
    return null;
  }

  useEffect(() => {
    fetchCashPayments();
  }, []);

  const fetchCashPayments = async () => {
    try {
      const { data, error } = await supabase
        .from('cash_payments')
        .select(`
          *,
          user:users!cash_payments_user_id_fkey(*),
          booking:seat_bookings!cash_payments_booking_id_fkey(*),
          admission:admissions!cash_payments_admission_id_fkey(*)
        `)
        .order('created_at', { ascending: false });

      if (error) throw error;

      setCashPayments(data || []);
    } catch (error) {
      console.error('Error fetching cash payments:', error);
    } finally {
      setLoading(false);
    }
  };

  const onRefresh = async () => {
    setRefreshing(true);
    await fetchCashPayments();
    setRefreshing(false);
  };

  const handlePaymentAction = async (payment: CashPaymentWithDetails, action: 'approve' | 'reject') => {
    const paymentId = payment.id;
    setProcessing(paymentId);

    try {
      // Update cash payment status
      const { error } = await supabase
        .from('cash_payments')
        .update({
          status: action === 'approve' ? 'approved' : 'rejected',
          approved_by: user?.id,
          approved_at: new Date().toISOString()
        })
        .eq('id', paymentId);

      if (error) throw error;

      if (action === 'approve') {
        // If it's a booking payment, update the booking status to 'booked'
        if (payment.booking_id) {
          const { error: bookingError } = await supabase
            .from('seat_bookings')
            .update({ booking_status: 'booked' })
            .eq('id', payment.booking_id);

          if (bookingError) throw bookingError;
        }

        // If it's an admission payment, update the admission status and dates
        if (payment.admission_id) {
          const startDate = new Date().toISOString();
          const { data: admission, error: admissionFetchError } = await supabase
            .from('admissions')
            .select('duration')
            .eq('id', payment.admission_id)
            .single();

          if (admissionFetchError) throw admissionFetchError;

          const endDate = new Date();
          endDate.setMonth(endDate.getMonth() + admission.duration);

          const { error: admissionError } = await supabase
            .from('admissions')
            .update({
              payment_status: 'paid',
              payment_date: startDate,
              start_date: startDate,
              end_date: endDate.toISOString()
            })
            .eq('id', payment.admission_id);

          if (admissionError) throw admissionError;

          // Create payment history record
          await supabase
            .from('payment_history')
            .insert({
              user_id: payment.user_id,
              amount: payment.amount,
              payment_mode: 'cash',
              duration_months: admission.duration,
              payment_date: startDate,
              receipt_number: `LCL-CASH-${Date.now()}`,
            });
        }
      } else if (action === 'reject') {
        // If rejected, remove the booking (if it exists)
        if (payment.booking_id) {
          const { error: bookingError } = await supabase
            .from('seat_bookings')
            .delete()
            .eq('id', payment.booking_id);

          if (bookingError) throw bookingError;
        }

        // If rejected admission payment, keep admission as pending
        if (payment.admission_id) {
          const { error: admissionError } = await supabase
            .from('admissions')
            .update({ payment_status: 'pending' })
            .eq('id', payment.admission_id);

          if (admissionError) throw admissionError;
        }

        // Send notification to student about rejection
        await supabase
          .from('notifications')
          .insert({
            user_id: payment.user_id,
            title: 'Payment Rejected',
            message: `Your cash payment of ₹${payment.amount} has been rejected. Please contact the library for more information.`,
            type: 'error',
            created_by: user?.id
          });
      }

      // Log admin action
      await supabase
        .from('admin_logs')
        .insert({
          admin_id: user?.id,
          action: `${action}_cash_payment`,
          details: { 
            payment_id: paymentId, 
            amount: payment.amount,
            user_name: payment.user?.full_name,
            payment_type: payment.booking_id ? 'booking' : 'admission'
          }
        });

      // Send success notification to student if approved
      if (action === 'approve') {
        await supabase
          .from('notifications')
          .insert({
            user_id: payment.user_id,
            title: 'Payment Approved',
            message: `Your cash payment of ₹${payment.amount} has been approved. ${payment.booking_id ? 'Your seat booking is now confirmed.' : 'Your admission is now active.'}`,
            type: 'success',
            created_by: user?.id
          });
      }

      Alert.alert(
        'Success',
        `Payment ${action === 'approve' ? 'approved' : 'rejected'} successfully.`
      );

      await fetchCashPayments();
    } catch (error) {
      console.error(`Error ${action}ing payment:`, error);
      Alert.alert('Error', `Failed to ${action} payment. Please try again.`);
    } finally {
      setProcessing(null);
    }
  };

  const confirmAction = (payment: CashPaymentWithDetails, action: 'approve' | 'reject') => {
    const paymentType = payment.booking_id ? 'seat booking' : 'admission';
    const details = payment.booking_id 
      ? `Seat ${payment.booking?.seat_number} for ${payment.booking?.shift} shift`
      : `Admission for ${payment.admission?.course_name}`;

    Alert.alert(
      `${action === 'approve' ? 'Approve' : 'Reject'} Payment`,
      `Are you sure you want to ${action} the ${paymentType} payment of ₹${payment.amount} from ${payment.user?.full_name || 'Unknown User'}?\n\nDetails: ${details}`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: action === 'approve' ? 'Approve' : 'Reject',
          style: action === 'approve' ? 'default' : 'destructive',
          onPress: () => handlePaymentAction(payment, action)
        }
      ]
    );
  };

  if (loading) {
    return <LoadingSpinner />;
  }

  const pendingPayments = cashPayments.filter(p => p.status === 'pending');
  const processedPayments = cashPayments.filter(p => p.status !== 'pending');

  return (
    <ScrollView 
      style={styles.container}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      <View style={styles.header}>
        <Button
          onPress={() => router.back()}
          variant="outline"
          style={styles.backButton}
        >
          <ArrowLeft size={20} color="#2563EB" />
        </Button>
        <Text style={styles.title}>Cash Payments</Text>
        <Text style={styles.subtitle}>Manage cash payment approvals</Text>
      </View>

      {/* Pending Payments */}
      <Card style={styles.sectionCard}>
        <Text style={styles.sectionTitle}>
          Pending Approvals ({pendingPayments.length})
        </Text>
        
        {pendingPayments.length === 0 ? (
          <View style={styles.emptyState}>
            <CheckCircle size={48} color="#10B981" />
            <Text style={styles.emptyTitle}>All Caught Up!</Text>
            <Text style={styles.emptyText}>No pending cash payments to review</Text>
          </View>
        ) : (
          <View style={styles.paymentsList}>
            {pendingPayments.map((payment) => (
              <View key={payment.id} style={styles.paymentItem}>
                <View style={styles.paymentHeader}>
                  <View style={styles.userInfo}>
                    <Text style={styles.userName}>{payment.user?.full_name || 'N/A'}</Text>
                    <Text style={styles.userEmail}>{payment.user?.email || 'N/A'}</Text>
                    <Text style={styles.userMobile}>{payment.user?.mobile_number || 'N/A'}</Text>
                  </View>
                  <View style={styles.amountContainer}>
                    <Text style={styles.amount}>₹{payment.amount}</Text>
                    <View style={styles.pendingBadge}>
                      <Clock size={12} color="#FFFFFF" />
                      <Text style={styles.pendingText}>PENDING</Text>
                    </View>
                  </View>
                </View>

                <View style={styles.paymentDetails}>
                  {payment.booking_id && payment.booking && (
                    <View style={styles.bookingDetails}>
                      <View style={styles.detailRow}>
                        <MapPin size={14} color="#64748B" />
                        <Text style={styles.detailText}>
                          Seat {payment.booking.seat_number} - {payment.booking.shift.toUpperCase()} shift
                        </Text>
                      </View>
                      <View style={styles.detailRow}>
                        <Calendar size={14} color="#64748B" />
                        <Text style={styles.detailText}>
                          Date: {new Date(payment.booking.booking_date).toLocaleDateString('en-IN')}
                        </Text>
                      </View>
                    </View>
                  )}
                  
                  {payment.admission_id && payment.admission && (
                    <View style={styles.admissionDetails}>
                      <View style={styles.detailRow}>
                        <GraduationCap size={14} color="#64748B" />
                        <Text style={styles.detailText}>
                          Course: {payment.admission.course_name}
                        </Text>
                      </View>
                      <View style={styles.detailRow}>
                        <Clock size={14} color="#64748B" />
                        <Text style={styles.detailText}>
                          Duration: {payment.admission.duration} month{payment.admission.duration > 1 ? 's' : ''}
                        </Text>
                      </View>
                      <View style={styles.detailRow}>
                        <Calendar size={14} color="#64748B" />
                        <Text style={styles.detailText}>
                          Shifts: {payment.admission.selected_shifts.join(', ')}
                        </Text>
                      </View>
                    </View>
                  )}
                  
                  <Text style={styles.detailText}>
                    Submitted: {formatDate(payment.created_at)}
                  </Text>
                  <Text style={styles.detailText}>
                    Type: {payment.admission_id ? 'Admission Payment' : 'Seat Booking Payment'}
                  </Text>
                </View>

                <View style={styles.actionButtons}>
                  <Button
                    title="Approve"
                    onPress={() => confirmAction(payment, 'approve')}
                    disabled={processing === payment.id}
                    size="small"
                    style={styles.approveButton}
                  >
                    <View style={styles.buttonContent}>
                      <CheckCircle size={16} color="#FFFFFF" />
                      <Text style={styles.buttonText}>Approve</Text>
                    </View>
                  </Button>

                  <Button
                    title="Reject"
                    onPress={() => confirmAction(payment, 'reject')}
                    disabled={processing === payment.id}
                    variant="danger"
                    size="small"
                    style={styles.rejectButton}
                  >
                    <View style={styles.buttonContent}>
                      <XCircle size={16} color="#FFFFFF" />
                      <Text style={styles.buttonText}>Reject</Text>
                    </View>
                  </Button>
                </View>
              </View>
            ))}
          </View>
        )}
      </Card>

      {/* Payment History */}
      {processedPayments.length > 0 && (
        <Card style={styles.sectionCard}>
          <Text style={styles.sectionTitle}>Payment History</Text>
          <View style={styles.paymentsList}>
            {processedPayments.map((payment) => (
              <View key={payment.id} style={styles.historyItem}>
                <View style={styles.paymentHeader}>
                  <View style={styles.userInfo}>
                    <Text style={styles.userName}>{payment.user?.full_name || 'N/A'}</Text>
                    <Text style={styles.userEmail}>{payment.user?.email || 'N/A'}</Text>
                  </View>
                  <View style={styles.amountContainer}>
                    <Text style={styles.amount}>₹{payment.amount}</Text>
                    <View style={[
                      styles.statusBadge,
                      payment.status === 'approved' ? styles.approvedBadge : styles.rejectedBadge
                    ]}>
                      {payment.status === 'approved' ? (
                        <CheckCircle size={12} color="#FFFFFF" />
                      ) : (
                        <XCircle size={12} color="#FFFFFF" />
                      )}
                      <Text style={styles.statusText}>
                        {payment.status.toUpperCase()}
                      </Text>
                    </View>
                  </View>
                </View>

                <View style={styles.paymentDetails}>
                  <Text style={styles.detailText}>
                    Processed: {formatDate(payment.approved_at || payment.created_at)}
                  </Text>
                  <Text style={styles.detailText}>
                    Type: {payment.admission_id ? 'Admission Payment' : 'Seat Booking Payment'}
                  </Text>
                </View>
              </View>
            ))}
          </View>
        </Card>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F8FAFC',
  },
  header: {
    padding: 24,
    paddingTop: 48,
  },
  backButton: {
    alignSelf: 'flex-start',
    marginBottom: 16,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  title: {
    fontSize: 28,
    fontWeight: 'bold',
    color: '#1E293B',
  },
  subtitle: {
    fontSize: 16,
    color: '#64748B',
    marginTop: 4,
  },
  sectionCard: {
    margin: 16,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#1E293B',
    marginBottom: 16,
  },
  emptyState: {
    alignItems: 'center',
    padding: 32,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#1E293B',
    marginTop: 16,
    marginBottom: 8,
  },
  emptyText: {
    fontSize: 14,
    color: '#64748B',
    textAlign: 'center',
  },
  paymentsList: {
    gap: 16,
  },
  paymentItem: {
    backgroundColor: '#F8FAFC',
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  historyItem: {
    backgroundColor: '#F8FAFC',
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    opacity: 0.8,
  },
  paymentHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 12,
  },
  userInfo: {
    flex: 1,
  },
  userName: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1E293B',
    marginBottom: 2,
  },
  userEmail: {
    fontSize: 14,
    color: '#64748B',
  },
  userMobile: {
    fontSize: 12,
    color: '#64748B',
  },
  amountContainer: {
    alignItems: 'flex-end',
  },
  amount: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#10B981',
    marginBottom: 4,
  },
  pendingBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F59E0B',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
    gap: 4,
  },
  pendingText: {
    fontSize: 10,
    color: '#FFFFFF',
    fontWeight: 'bold',
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
    gap: 4,
  },
  approvedBadge: {
    backgroundColor: '#10B981',
  },
  rejectedBadge: {
    backgroundColor: '#EF4444',
  },
  statusText: {
    fontSize: 10,
    color: '#FFFFFF',
    fontWeight: 'bold',
  },
  paymentDetails: {
    marginBottom: 16,
  },
  bookingDetails: {
    marginBottom: 8,
  },
  admissionDetails: {
    marginBottom: 8,
  },
  detailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4,
    gap: 6,
  },
  detailText: {
    fontSize: 12,
    color: '#64748B',
    flex: 1,
  },
  actionButtons: {
    flexDirection: 'row',
    gap: 12,
  },
  approveButton: {
    flex: 1,
    backgroundColor: '#10B981',
  },
  rejectButton: {
    flex: 1,
  },
  buttonContent: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  buttonText: {
    fontSize: 14,
    color: '#FFFFFF',
    fontWeight: '600',
  },
});